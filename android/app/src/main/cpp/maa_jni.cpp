// JNI wrapper over the MaaFramework C API for io.github.flufy3d.maalow.engine.Maa.
// Handles are passed to Kotlin as jlong pointers; blocking calls (wait/run) are meant for worker threads.

#include <jni.h>

#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "MaaFramework/MaaAPI.h"

namespace
{

std::string str(JNIEnv* env, jstring s)
{
    if (!s) {
        return {};
    }
    const char* c = env->GetStringUTFChars(s, nullptr);
    std::string out(c);
    env->ReleaseStringUTFChars(s, c);
    return out;
}

jstring jstr(JNIEnv* env, const std::string& s)
{
    return env->NewStringUTF(s.c_str());
}

std::string json_escape(const std::string& s)
{
    std::string out;
    for (char c : s) {
        switch (c) {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\n':
            out += "\\n";
            break;
        default:
            if (static_cast<unsigned char>(c) < 0x20) {
                char buf[8];
                snprintf(buf, sizeof(buf), "\\u%04x", c);
                out += buf;
            }
            else {
                out += c;
            }
        }
    }
    return out;
}

template <typename T>
T* ptr(jlong h)
{
    return reinterpret_cast<T*>(h);
}

bool succeeded(MaaStatus s)
{
    return s == MaaStatus_Succeeded;
}

// Offline controller serving one encoded image and ignoring input, for checking rules on saved screenshots.
// (The Android release ships no DbgControlUnit.)
struct ImageController
{
    std::vector<uint8_t> encoded;
    MaaCustomControllerCallbacks callbacks {};
    MaaController* ctrl = nullptr;
};

MaaBool ok_arg(void*)
{
    return true;
}

template <typename... Args>
MaaBool ok(Args...)
{
    return true;
}

ImageController* image_controller_create(const std::string& path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        return nullptr;
    }
    auto* ic = new ImageController;
    ic->encoded.assign(std::istreambuf_iterator<char>(in), {});
    auto& cb = ic->callbacks;
    cb.connect = ok_arg;
    cb.connected = ok_arg;
    cb.request_uuid = [](void*, MaaStringBuffer* b) -> MaaBool { return MaaStringBufferSet(b, "image"); };
    cb.get_features = [](void*) -> MaaControllerFeature { return MaaControllerFeature_None; };
    cb.start_app = ok<const char*, void*>;
    cb.stop_app = ok<const char*, void*>;
    cb.screencap = [](void* arg, MaaImageBuffer* b) -> MaaBool {
        auto* self = static_cast<ImageController*>(arg);
        return MaaImageBufferSetEncoded(b, self->encoded.data(), self->encoded.size());
    };
    cb.click = ok<int32_t, int32_t, void*>;
    cb.swipe = ok<int32_t, int32_t, int32_t, int32_t, int32_t, void*>;
    cb.touch_down = ok<int32_t, int32_t, int32_t, int32_t, void*>;
    cb.touch_move = ok<int32_t, int32_t, int32_t, int32_t, void*>;
    cb.touch_up = ok<int32_t, void*>;
    cb.click_key = ok<int32_t, void*>;
    cb.input_text = ok<const char*, void*>;
    cb.key_down = ok<int32_t, void*>;
    cb.key_up = ok<int32_t, void*>;
    cb.scroll = ok<int32_t, int32_t, void*>;
    cb.relative_move = ok<int32_t, int32_t, void*>;
    cb.shell = [](const char*, int64_t, void*, MaaStringBuffer*) -> MaaBool { return false; };
    cb.inactive = ok_arg;
    cb.get_info = [](void*, MaaStringBuffer* b) -> MaaBool { return MaaStringBufferSet(b, "{\"type\":\"image\"}"); };
    ic->ctrl = MaaCustomControllerCreate(&cb, ic);
    if (!ic->ctrl) {
        delete ic;
        return nullptr;
    }
    return ic;
}

} // namespace

#define FN(ret, name) extern "C" JNIEXPORT ret JNICALL Java_io_github_flufy3d_maalow_engine_Maa_##name

// ---- global

FN(jstring, version)(JNIEnv* env, jobject)
{
    return jstr(env, MaaVersion());
}

FN(jboolean, setLogDir)(JNIEnv* env, jobject, jstring dir)
{
    std::string d = str(env, dir);
    return MaaGlobalSetOption(MaaGlobalOption_LogDir, (void*)d.c_str(), d.size());
}

FN(jboolean, setDebugMode)(JNIEnv*, jobject, jboolean on)
{
    bool v = on;
    return MaaGlobalSetOption(MaaGlobalOption_DebugMode, &v, sizeof(v));
}

// ---- resource

FN(jlong, resourceCreate)(JNIEnv*, jobject)
{
    return reinterpret_cast<jlong>(MaaResourceCreate());
}

FN(void, resourceDestroy)(JNIEnv*, jobject, jlong h)
{
    MaaResourceDestroy(ptr<MaaResource>(h));
}

// kind: 0 bundle, 1 pipeline, 2 image, 3 ocr model. Blocks until loaded; true on success.
FN(jboolean, resourceLoad)(JNIEnv* env, jobject, jlong h, jint kind, jstring path)
{
    auto* res = ptr<MaaResource>(h);
    std::string p = str(env, path);
    MaaResId id = 0;
    switch (kind) {
    case 0:
        id = MaaResourcePostBundle(res, p.c_str());
        break;
    case 1:
        id = MaaResourcePostPipeline(res, p.c_str());
        break;
    case 2:
        id = MaaResourcePostImage(res, p.c_str());
        break;
    case 3:
        id = MaaResourcePostOcrModel(res, p.c_str());
        break;
    default:
        return false;
    }
    return succeeded(MaaResourceWait(res, id));
}

FN(jstring, resourceNodeList)(JNIEnv* env, jobject, jlong h)
{
    MaaStringListBuffer* list = MaaStringListBufferCreate();
    std::string out = "[";
    if (MaaResourceGetNodeList(ptr<MaaResource>(h), list)) {
        for (MaaSize i = 0; i < MaaStringListBufferSize(list); ++i) {
            out += std::string(i ? "," : "") + "\"" + json_escape(MaaStringBufferGet(MaaStringListBufferAt(list, i))) + "\"";
        }
    }
    MaaStringListBufferDestroy(list);
    return jstr(env, out + "]");
}

// ---- controller

FN(jlong, controllerCreateNative)(JNIEnv* env, jobject, jstring config)
{
    return reinterpret_cast<jlong>(MaaAndroidNativeControllerCreate(str(env, config).c_str()));
}

// Returns an ImageController handle; use imageControllerGet for the MaaController.
FN(jlong, imageControllerCreate)(JNIEnv* env, jobject, jstring path)
{
    return reinterpret_cast<jlong>(image_controller_create(str(env, path)));
}

FN(jlong, imageControllerGet)(JNIEnv*, jobject, jlong h)
{
    return reinterpret_cast<jlong>(ptr<ImageController>(h)->ctrl);
}

FN(void, imageControllerDestroy)(JNIEnv*, jobject, jlong h)
{
    auto* ic = ptr<ImageController>(h);
    MaaControllerDestroy(ic->ctrl);
    delete ic;
}

FN(void, controllerDestroy)(JNIEnv*, jobject, jlong h)
{
    MaaControllerDestroy(ptr<MaaController>(h));
}

FN(jboolean, controllerUseRawSize)(JNIEnv*, jobject, jlong h)
{
    bool v = true;
    return MaaControllerSetOption(ptr<MaaController>(h), MaaCtrlOption_ScreenshotUseRawSize, &v, sizeof(v));
}

FN(jboolean, controllerConnect)(JNIEnv*, jobject, jlong h)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostConnection(c)));
}

FN(jboolean, controllerScreencap)(JNIEnv*, jobject, jlong h)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostScreencap(c)));
}

FN(jboolean, controllerClick)(JNIEnv*, jobject, jlong h, jint x, jint y)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostClick(c, x, y)));
}

FN(jboolean, controllerSwipe)(JNIEnv*, jobject, jlong h, jint x1, jint y1, jint x2, jint y2, jint duration)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostSwipe(c, x1, y1, x2, y2, duration)));
}

// type: 0 down, 1 move, 2 up
FN(jboolean, controllerTouch)(JNIEnv*, jobject, jlong h, jint type, jint contact, jint x, jint y)
{
    auto* c = ptr<MaaController>(h);
    MaaCtrlId id = type == 0 ? MaaControllerPostTouchDown(c, contact, x, y, 1)
                   : type == 1 ? MaaControllerPostTouchMove(c, contact, x, y, 1)
                               : MaaControllerPostTouchUp(c, contact);
    return succeeded(MaaControllerWait(c, id));
}

FN(jboolean, controllerKey)(JNIEnv*, jobject, jlong h, jint code)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostClickKey(c, code)));
}

FN(jboolean, controllerInputText)(JNIEnv* env, jobject, jlong h, jstring text)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostInputText(c, str(env, text).c_str())));
}

FN(jboolean, controllerStartApp)(JNIEnv* env, jobject, jlong h, jstring intent)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostStartApp(c, str(env, intent).c_str())));
}

FN(jboolean, controllerStopApp)(JNIEnv* env, jobject, jlong h, jstring intent)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostStopApp(c, str(env, intent).c_str())));
}

// ---- tasker

FN(jlong, taskerCreate)(JNIEnv*, jobject)
{
    return reinterpret_cast<jlong>(MaaTaskerCreate());
}

FN(void, taskerDestroy)(JNIEnv*, jobject, jlong h)
{
    MaaTaskerDestroy(ptr<MaaTasker>(h));
}

FN(jboolean, taskerBind)(JNIEnv*, jobject, jlong h, jlong res, jlong ctrl)
{
    auto* t = ptr<MaaTasker>(h);
    return MaaTaskerBindResource(t, ptr<MaaResource>(res)) && MaaTaskerBindController(t, ptr<MaaController>(ctrl))
           && MaaTaskerInited(t);
}

FN(void, taskerStop)(JNIEnv*, jobject, jlong h)
{
    MaaTaskerPostStop(ptr<MaaTasker>(h));
}

// Run a task to completion. Returns {"status":int,"entry":str,"nodes":[{"name","completed","reco","action"}]}.
FN(jstring, taskerRun)(JNIEnv* env, jobject, jlong h, jstring entry, jstring override_json)
{
    auto* t = ptr<MaaTasker>(h);
    std::string ov = str(env, override_json);
    MaaTaskId id = MaaTaskerPostTask(t, str(env, entry).c_str(), ov.empty() ? "{}" : ov.c_str());
    MaaTaskerWait(t, id);

    MaaStringBuffer* name = MaaStringBufferCreate();
    MaaSize size = 0;
    MaaStatus status = MaaStatus_Invalid;
    MaaTaskerGetTaskDetail(t, id, name, nullptr, &size, &status);
    std::vector<MaaNodeId> nodes(size);
    MaaTaskerGetTaskDetail(t, id, name, nodes.data(), &size, &status);
    std::string out = "{\"status\":" + std::to_string(status) + ",\"entry\":\"" + json_escape(MaaStringBufferGet(name))
                      + "\",\"nodes\":[";
    for (MaaSize i = 0; i < size; ++i) {
        MaaRecoId reco = 0;
        MaaActId act = 0;
        MaaBool completed = false;
        MaaTaskerGetNodeDetail(t, nodes[i], name, &reco, &act, &completed);
        out += std::string(i ? "," : "") + "{\"name\":\"" + json_escape(MaaStringBufferGet(name)) + "\",\"completed\":"
               + (completed ? "true" : "false") + ",\"reco\":" + std::to_string(reco) + ",\"action\":" + std::to_string(act)
               + "}";
    }
    MaaStringBufferDestroy(name);
    return jstr(env, out + "]}");
}

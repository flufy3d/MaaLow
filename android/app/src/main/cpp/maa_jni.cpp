// JNI wrapper over the MaaFramework C API for io.github.flufy3d.maalow.engine.Maa.
// Handles are passed to Kotlin as jlong pointers; blocking calls (wait/run) are meant for worker threads.
// Custom actions and recognitions (skills) call back into Maa.onCustomAction / onCustomRecognition on the
// tasker's own thread, which is attached to the VM on first use.

#include <jni.h>

#include <android/log.h>
#include <pthread.h>

#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "MaaFramework/MaaAPI.h"

#define LOG_TAG "MaaLowJni"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace
{

JavaVM* g_vm = nullptr;
pthread_key_t g_attached; // set on threads we attached, to detach them when they exit
jclass g_maa = nullptr;
jmethodID g_on_action = nullptr;
jmethodID g_on_recognition = nullptr;

// Strings are converted between UTF-16 and real UTF-8 here: JNI's modified UTF-8 breaks on characters outside
// the BMP, which OCR text and pipeline descriptions can contain.
std::string str(JNIEnv* env, jstring s)
{
    std::string out;
    if (!s) {
        return out;
    }
    const jsize n = env->GetStringLength(s);
    const jchar* c = env->GetStringChars(s, nullptr);
    for (jsize i = 0; i < n; ++i) {
        uint32_t cp = c[i];
        if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < n && c[i + 1] >= 0xDC00 && c[i + 1] < 0xE000) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (c[++i] - 0xDC00);
        }
        if (cp < 0x80) {
            out += char(cp);
        }
        else if (cp < 0x800) {
            out += char(0xC0 | (cp >> 6));
            out += char(0x80 | (cp & 0x3F));
        }
        else if (cp < 0x10000) {
            out += char(0xE0 | (cp >> 12));
            out += char(0x80 | ((cp >> 6) & 0x3F));
            out += char(0x80 | (cp & 0x3F));
        }
        else {
            out += char(0xF0 | (cp >> 18));
            out += char(0x80 | ((cp >> 12) & 0x3F));
            out += char(0x80 | ((cp >> 6) & 0x3F));
            out += char(0x80 | (cp & 0x3F));
        }
    }
    env->ReleaseStringChars(s, c);
    return out;
}

jstring jstr(JNIEnv* env, const std::string& s)
{
    std::u16string u;
    u.reserve(s.size());
    for (size_t i = 0; i < s.size();) {
        auto b = static_cast<unsigned char>(s[i]);
        uint32_t cp = 0xFFFD;
        int n = b < 0x80 ? 1 : (b >> 5) == 6 ? 2 : (b >> 4) == 14 ? 3 : (b >> 3) == 30 ? 4 : 0;
        if (n == 0 || i + n > s.size()) {
            ++i;
        }
        else {
            cp = n == 1 ? b : b & (0x7F >> n);
            for (int k = 1; k < n; ++k) {
                cp = (cp << 6) | (static_cast<unsigned char>(s[i + k]) & 0x3F);
            }
            i += n;
        }
        if (cp >= 0x10000) {
            cp -= 0x10000;
            u += char16_t(0xD800 + (cp >> 10));
            u += char16_t(0xDC00 + (cp & 0x3FF));
        }
        else {
            u += char16_t(cp);
        }
    }
    return env->NewString(reinterpret_cast<const jchar*>(u.data()), jsize(u.size()));
}

JNIEnv* attach()
{
    JNIEnv* env = nullptr;
    if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_OK) {
        return env;
    }
    JavaVMAttachArgs args { JNI_VERSION_1_6, "maa-custom", nullptr };
    if (g_vm->AttachCurrentThread(&env, &args) != JNI_OK) {
        return nullptr;
    }
    pthread_setspecific(g_attached, env);
    return env;
}

// A Kotlin exception from a callback: log it and report failure to Maa.
bool failed(JNIEnv* env, const char* what)
{
    if (!env->ExceptionCheck()) {
        return false;
    }
    LOGE("%s threw", what);
    env->ExceptionDescribe();
    env->ExceptionClear();
    return true;
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

std::string box_json(const MaaRect& b)
{
    return "[" + std::to_string(b.x) + "," + std::to_string(b.y) + "," + std::to_string(b.width) + "," + std::to_string(b.height)
           + "]";
}

// {"id","hit","box","algorithm","detail"}; detail is Maa's own JSON (null when there is none).
std::string reco_detail(MaaTasker* t, MaaRecoId id)
{
    if (id == MaaInvalidId) {
        return R"({"id":0,"hit":false,"box":null,"algorithm":"","detail":null})";
    }
    MaaStringBuffer* node = MaaStringBufferCreate();
    MaaStringBuffer* algorithm = MaaStringBufferCreate();
    MaaStringBuffer* detail = MaaStringBufferCreate();
    MaaBool hit = false;
    MaaRect box {};
    MaaTaskerGetRecognitionDetail(t, id, node, algorithm, &hit, &box, detail, nullptr, nullptr);
    std::string d = MaaStringBufferGet(detail);
    std::string out = "{\"id\":" + std::to_string(id) + ",\"hit\":" + (hit ? "true" : "false") + ",\"box\":"
                      + (hit ? box_json(box) : "null") + ",\"algorithm\":\"" + json_escape(MaaStringBufferGet(algorithm))
                      + "\",\"detail\":" + (d.empty() ? "null" : d) + "}";
    MaaStringBufferDestroy(node);
    MaaStringBufferDestroy(algorithm);
    MaaStringBufferDestroy(detail);
    return out;
}

// {"id","status","entry","nodes":[{"name","completed","reco","action"}]}
std::string task_detail(MaaTasker* t, MaaTaskId id)
{
    MaaStringBuffer* name = MaaStringBufferCreate();
    MaaSize size = 0;
    MaaStatus status = MaaStatus_Invalid;
    MaaTaskerGetTaskDetail(t, id, name, nullptr, &size, &status);
    std::vector<MaaNodeId> nodes(size);
    MaaTaskerGetTaskDetail(t, id, name, nodes.data(), &size, &status);
    std::string out = "{\"id\":" + std::to_string(id) + ",\"status\":" + std::to_string(status) + ",\"entry\":\""
                      + json_escape(MaaStringBufferGet(name)) + "\",\"nodes\":[";
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
    return out + "]}";
}

// ---- custom action / recognition trampolines (both registered under a skill's name)

MaaBool MAA_CALL custom_action(
    MaaContext* context,
    MaaTaskId task_id,
    const char* node_name,
    const char* name,
    const char* param,
    MaaRecoId reco_id,
    const MaaRect* box,
    void*)
{
    JNIEnv* env = attach();
    if (!env || env->PushLocalFrame(16) != JNI_OK) {
        return false;
    }
    jintArray b = env->NewIntArray(4);
    jint v[4] = { box ? box->x : 0, box ? box->y : 0, box ? box->width : 0, box ? box->height : 0 };
    env->SetIntArrayRegion(b, 0, 4, v);
    jboolean ok = env->CallStaticBooleanMethod(
        g_maa,
        g_on_action,
        reinterpret_cast<jlong>(context),
        jlong(task_id),
        jstr(env, node_name ? node_name : ""),
        jstr(env, name ? name : ""),
        jstr(env, param ? param : ""),
        jlong(reco_id),
        b);
    if (failed(env, "onCustomAction")) {
        ok = false;
    }
    env->PopLocalFrame(nullptr);
    return ok;
}

MaaBool MAA_CALL custom_recognition(
    MaaContext* context,
    MaaTaskId task_id,
    const char* node_name,
    const char* name,
    const char* param,
    const MaaImageBuffer* image,
    const MaaRect* roi,
    void*,
    MaaRect* out_box,
    MaaStringBuffer* out_detail)
{
    JNIEnv* env = attach();
    if (!env || env->PushLocalFrame(16) != JNI_OK) {
        return false;
    }
    jintArray r = env->NewIntArray(4);
    jint v[4] = { roi ? roi->x : 0, roi ? roi->y : 0, roi ? roi->width : 0, roi ? roi->height : 0 };
    env->SetIntArrayRegion(r, 0, 4, v);
    jintArray out = env->NewIntArray(4);
    auto detail = static_cast<jstring>(env->CallStaticObjectMethod(
        g_maa,
        g_on_recognition,
        reinterpret_cast<jlong>(context),
        jlong(task_id),
        jstr(env, node_name ? node_name : ""),
        jstr(env, name ? name : ""),
        jstr(env, param ? param : ""),
        reinterpret_cast<jlong>(image),
        r,
        out));
    bool hit = !failed(env, "onCustomRecognition") && detail;
    if (hit) {
        jint o[4];
        env->GetIntArrayRegion(out, 0, 4, o);
        *out_box = MaaRect { o[0], o[1], o[2], o[3] };
        MaaStringBufferSet(out_detail, str(env, detail).c_str());
    }
    env->PopLocalFrame(nullptr);
    return hit;
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

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*)
{
    g_vm = vm;
    pthread_key_create(&g_attached, [](void*) { g_vm->DetachCurrentThread(); });
    JNIEnv* env = nullptr;
    vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
    jclass maa = env->FindClass("io/github/flufy3d/maalow/engine/Maa");
    if (!maa) {
        return JNI_ERR;
    }
    g_maa = static_cast<jclass>(env->NewGlobalRef(maa));
    g_on_action = env->GetStaticMethodID(g_maa, "onCustomAction", "(JJLjava/lang/String;Ljava/lang/String;Ljava/lang/String;J[I)Z");
    g_on_recognition = env->GetStaticMethodID(
        g_maa,
        "onCustomRecognition",
        "(JJLjava/lang/String;Ljava/lang/String;Ljava/lang/String;J[I[I)Ljava/lang/String;");
    if (!g_on_action || !g_on_recognition) {
        return JNI_ERR;
    }
    return JNI_VERSION_1_6;
}

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

// Register a skill as custom action "name" and custom recognition "name.recognize" (actions and recognitions share
// one namespace in Maa).
FN(jboolean, resourceRegisterCustom)(JNIEnv* env, jobject, jlong h, jstring name)
{
    auto* res = ptr<MaaResource>(h);
    std::string n = str(env, name);
    return MaaResourceRegisterCustomAction(res, n.c_str(), custom_action, nullptr)
           && MaaResourceRegisterCustomRecognition(res, (n + ".recognize").c_str(), custom_recognition, nullptr);
}

FN(void, resourceUnregisterCustom)(JNIEnv* env, jobject, jlong h, jstring name)
{
    auto* res = ptr<MaaResource>(h);
    std::string n = str(env, name);
    MaaResourceUnregisterCustomAction(res, n.c_str());
    MaaResourceUnregisterCustomRecognition(res, (n + ".recognize").c_str());
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

// type: 0 down, 1 up
FN(jboolean, controllerKeyState)(JNIEnv*, jobject, jlong h, jint type, jint code)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, type == 0 ? MaaControllerPostKeyDown(c, code) : MaaControllerPostKeyUp(c, code)));
}

// Take a screenshot into an image buffer.
FN(jboolean, controllerScreencapInto)(JNIEnv*, jobject, jlong h, jlong image)
{
    auto* c = ptr<MaaController>(h);
    return succeeded(MaaControllerWait(c, MaaControllerPostScreencap(c))) && MaaControllerCachedImage(c, ptr<MaaImageBuffer>(image));
}

// ---- image buffers

FN(jlong, imageCreate)(JNIEnv*, jobject)
{
    return reinterpret_cast<jlong>(MaaImageBufferCreate());
}

FN(void, imageDestroy)(JNIEnv*, jobject, jlong h)
{
    MaaImageBufferDestroy(ptr<MaaImageBuffer>(h));
}

// The image PNG-encoded.
FN(jbyteArray, imageEncoded)(JNIEnv* env, jobject, jlong h)
{
    auto* img = ptr<MaaImageBuffer>(h);
    MaaSize size = MaaImageBufferGetEncodedSize(img);
    jbyteArray out = env->NewByteArray(jsize(size));
    env->SetByteArrayRegion(out, 0, jsize(size), reinterpret_cast<const jbyte*>(MaaImageBufferGetEncoded(img)));
    return out;
}

// ---- context (inside a custom action or recognition, on the tasker's thread)

FN(jlong, contextController)(JNIEnv*, jobject, jlong h)
{
    return reinterpret_cast<jlong>(MaaTaskerGetController(MaaContextGetTasker(ptr<MaaContext>(h))));
}

// A pipeline node's definition as JSON, or null when there is no such node.
FN(jstring, contextNodeData)(JNIEnv* env, jobject, jlong h, jstring node)
{
    MaaStringBuffer* buf = MaaStringBufferCreate();
    bool ok = MaaContextGetNodeData(ptr<MaaContext>(h), str(env, node).c_str(), buf);
    jstring out = ok ? jstr(env, MaaStringBufferGet(buf)) : nullptr;
    MaaStringBufferDestroy(buf);
    return out;
}

// Recognize with a pipeline node (plus override) on an image; returns reco_detail JSON.
FN(jstring, contextRecognize)(JNIEnv* env, jobject, jlong h, jstring entry, jstring override_json, jlong image)
{
    auto* ctx = ptr<MaaContext>(h);
    std::string ov = str(env, override_json);
    MaaRecoId id = MaaContextRunRecognition(ctx, str(env, entry).c_str(), ov.empty() ? "{}" : ov.c_str(), ptr<MaaImageBuffer>(image));
    return jstr(env, reco_detail(MaaContextGetTasker(ctx), id));
}

// Recognize with a recognition type ("TemplateMatch", "OCR", ...) and its parameters; returns reco_detail JSON.
FN(jstring, contextRecognizeDirect)(JNIEnv* env, jobject, jlong h, jstring type, jstring param, jlong image)
{
    auto* ctx = ptr<MaaContext>(h);
    MaaRecoId id = MaaContextRunRecognitionDirect(ctx, str(env, type).c_str(), str(env, param).c_str(), ptr<MaaImageBuffer>(image));
    return jstr(env, reco_detail(MaaContextGetTasker(ctx), id));
}

// Run a pipeline task from a node within the current task; returns task_detail JSON.
FN(jstring, contextRunTask)(JNIEnv* env, jobject, jlong h, jstring entry, jstring override_json)
{
    auto* ctx = ptr<MaaContext>(h);
    std::string ov = str(env, override_json);
    MaaTaskId id = MaaContextRunTask(ctx, str(env, entry).c_str(), ov.empty() ? "{}" : ov.c_str());
    return jstr(env, task_detail(MaaContextGetTasker(ctx), id));
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

// Run a task to completion. Returns task_detail JSON: {"id","status","entry","nodes":[{"name","completed","reco","action"}]}.
FN(jstring, taskerRun)(JNIEnv* env, jobject, jlong h, jstring entry, jstring override_json)
{
    auto* t = ptr<MaaTasker>(h);
    std::string ov = str(env, override_json);
    MaaTaskId id = MaaTaskerPostTask(t, str(env, entry).c_str(), ov.empty() ? "{}" : ov.c_str());
    MaaTaskerWait(t, id);
    return jstr(env, task_detail(t, id));
}

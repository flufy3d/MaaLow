// JNI for skills' infer() (skill/Nn.kt): ONNX models run with the onnxruntime MaaFramework already ships
// (libonnxruntime.so 1.19.2, loaded by libMaaFramework.so; only its C API, through OrtGetApiBase), and the
// preprocessing of a screenshot region into a small image (crop, resize, color: nn_prep.h) that a run keeps as frame
// history.
//
// provider "qnn" runs on a second, separate onnxruntime: the one with the QNN execution provider that the optional
// plugin APK (android/qnnplugin, io.github.flufy3d.maalow.qnn) carries with Qualcomm's QNN libraries. nnQnnLoad
// dlopen()s it by absolute path from the plugin's nativeLibraryDir, RTLD_LOCAL: the linker keys loaded libraries by
// path when given one, so it is a second soinfo beside MaaFramework's libonnxruntime.so (same soname, different file;
// its exports are versioned VERS_1.29.0 and only OrtGetApiBase is used, through dlsym on its own handle). MaaFramework's
// copy is looked up first (init()), and is the one every by-name lookup of "libonnxruntime.so" keeps finding, since
// it was loaded first. Each Model keeps the runtime it was made with; values never cross between the two.
//
// Sessions are created once per model file and kept by Nn.kt; nothing here keeps per-call state.

#include <dlfcn.h>
#include <jni.h>
#include <stdlib.h>
#include <unistd.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "MaaFramework/MaaAPI.h"
#include "nn_prep.h"
#include "onnxruntime_c_api.h"

namespace
{

// One onnxruntime: MaaFramework's (g_maa) or the QNN plugin's (g_qnn).
struct Rt
{
    const OrtApi* api = nullptr;
    OrtEnv* env = nullptr;
    OrtMemoryInfo* mem = nullptr;
    std::string version;
    std::string error;
};

Rt g_maa, g_qnn;
std::string g_qnn_dir; // the plugin's nativeLibraryDir, once loaded
std::mutex g_qnn_lock;

using AppendNnapi = OrtStatus* (*)(OrtSessionOptions*, uint32_t);
AppendNnapi g_nnapi = nullptr;

// The C API of an onnxruntime library handle, at the API version of our header (1.19; newer runtimes serve older
// versions), with an env and a CPU memory info. False with rt.error set on failure.
bool open_rt(void* lib, const char* what, Rt& rt)
{
    auto get = lib ? reinterpret_cast<const OrtApiBase* (*)()>(dlsym(lib, "OrtGetApiBase")) : nullptr;
    if (!get) {
        rt.error = std::string(what) + " not found";
        return false;
    }
    rt.version = get()->GetVersionString();
    const OrtApi* api = get()->GetApi(ORT_API_VERSION);
    if (!api) {
        rt.error = "onnxruntime " + rt.version + " lacks API version " + std::to_string(ORT_API_VERSION);
        return false;
    }
    OrtStatus* st = api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "maalow", &rt.env);
    if (!st) {
        st = api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &rt.mem);
    }
    if (st) {
        rt.error = api->GetErrorMessage(st);
        api->ReleaseStatus(st);
        return false;
    }
    rt.api = api;
    return true;
}

bool init()
{
    static std::once_flag once;
    std::call_once(once, [] {
        void* lib = dlopen("libonnxruntime.so", RTLD_NOW | RTLD_NOLOAD);
        if (!lib) {
            lib = dlopen("libonnxruntime.so", RTLD_NOW);
        }
        if (open_rt(lib, "libonnxruntime.so", g_maa)) {
            g_nnapi = reinterpret_cast<AppendNnapi>(dlsym(lib, "OrtSessionOptionsAppendExecutionProvider_Nnapi"));
        }
    });
    return g_maa.api != nullptr;
}

void throw_java(JNIEnv* env, const std::string& msg)
{
    env->ThrowNew(env->FindClass("java/lang/RuntimeException"), msg.c_str());
}

// An OrtStatus as a Java exception; true when there was an error.
bool failed(JNIEnv* env, const OrtApi* api, OrtStatus* st, const char* what)
{
    if (!st) {
        return false;
    }
    throw_java(env, std::string(what) + ": " + api->GetErrorMessage(st));
    api->ReleaseStatus(st);
    return true;
}

struct Tensor
{
    std::string name;
    int type = 0; // ONNXTensorElementDataType
    std::vector<int64_t> dims;
};

struct Model
{
    const Rt* rt = nullptr; // the onnxruntime the session belongs to
    OrtSession* session = nullptr;
    std::vector<Tensor> inputs, outputs;
    std::vector<const char*> in_names, out_names;
    std::string names_meta; // custom metadata "names" (YOLO exports: "{0: 'person', ...}")
};

std::string json_escape(const std::string& s)
{
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') {
            o += '\\';
            o += c;
        }
        else if (uint8_t(c) < 0x20) {
            char b[8];
            snprintf(b, sizeof b, "\\u%04x", c);
            o += b;
        }
        else {
            o += c;
        }
    }
    return o;
}

std::string tensors_json(const std::vector<Tensor>& ts)
{
    std::string o = "[";
    for (size_t i = 0; i < ts.size(); ++i) {
        o += std::string(i ? "," : "") + "{\"name\":\"" + json_escape(ts[i].name) + "\",\"type\":" +
             std::to_string(ts[i].type) + ",\"shape\":[";
        for (size_t d = 0; d < ts[i].dims.size(); ++d) {
            o += (d ? "," : "") + std::to_string(ts[i].dims[d]);
        }
        o += "]}";
    }
    return o + "]";
}

OrtStatus* read_tensors(const OrtApi* api, OrtSession* s, bool input, std::vector<Tensor>& out)
{
    OrtAllocator* alloc = nullptr;
    OrtStatus* st = api->GetAllocatorWithDefaultOptions(&alloc);
    size_t n = 0;
    if (!st) {
        st = input ? api->SessionGetInputCount(s, &n) : api->SessionGetOutputCount(s, &n);
    }
    for (size_t i = 0; !st && i < n; ++i) {
        char* name = nullptr;
        st = input ? api->SessionGetInputName(s, i, alloc, &name) : api->SessionGetOutputName(s, i, alloc, &name);
        if (st) {
            break;
        }
        Tensor t;
        t.name = name;
        api->AllocatorFree(alloc, name);
        OrtTypeInfo* ti = nullptr;
        st = input ? api->SessionGetInputTypeInfo(s, i, &ti) : api->SessionGetOutputTypeInfo(s, i, &ti);
        if (st) {
            break;
        }
        const OrtTensorTypeAndShapeInfo* tsi = nullptr;
        if (!api->CastTypeInfoToTensorInfo(ti, &tsi) && tsi) {
            ONNXTensorElementDataType et;
            size_t rank = 0;
            api->GetTensorElementType(tsi, &et);
            api->GetDimensionsCount(tsi, &rank);
            t.type = int(et);
            t.dims.resize(rank);
            api->GetDimensions(tsi, t.dims.data(), rank);
        }
        api->ReleaseTypeInfo(ti);
        out.push_back(std::move(t));
    }
    return st;
}

std::string names_metadata(const OrtApi* api, OrtSession* s)
{
    OrtModelMetadata* md = nullptr;
    if (api->SessionGetModelMetadata(s, &md)) {
        return "";
    }
    std::string out;
    OrtAllocator* alloc = nullptr;
    char* v = nullptr;
    if (!api->GetAllocatorWithDefaultOptions(&alloc) && !api->ModelMetadataLookupCustomMetadataMap(md, alloc, "names", &v) && v) {
        out = v;
        api->AllocatorFree(alloc, v);
    }
    api->ReleaseModelMetadata(md);
    return out;
}

// The image input (inputs[0]) as an OrtValue, as nnRun builds it: frames (HWC uint8, cpf channels, w x h) stacked as
// channels in order, p as in nnRun. xf / xu hold the copied data and must outlive the value. Null (with a Java
// exception) on failure.
OrtValue* image_input(JNIEnv* env, Model* m, jobjectArray frames, const std::vector<float>& p, std::vector<float>& xf, std::vector<uint8_t>& xu)
{
    if (p.size() < 4) {
        throw_java(env, "infer: bad parameters");
        return nullptr;
    }
    const int nf = env->GetArrayLength(frames);
    const int w = int(p[0]), hh = int(p[1]), cpf = int(p[2]), nhwc = int(p[3]);
    const int C = nf * cpf;
    const size_t plane = size_t(w) * hh;
    if (m->inputs.empty() || p.size() < size_t(4 + 2 * C)) {
        throw_java(env, "infer: bad parameters");
        return nullptr;
    }
    const Tensor& in = m->inputs[0];
    const bool u8 = in.type == ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8;
    if (!u8 && in.type != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
        throw_java(env, "infer: the model's input must be float32 or uint8");
        return nullptr;
    }
    xf.resize(u8 ? 0 : plane * C);
    xu.resize(u8 ? plane * C : 0);
    for (int f = 0; f < nf; ++f) {
        auto arr = static_cast<jbyteArray>(env->GetObjectArrayElement(frames, f));
        if (size_t(env->GetArrayLength(arr)) < plane * cpf) {
            throw_java(env, "infer: frame size does not match");
            return nullptr;
        }
        auto* src = reinterpret_cast<uint8_t*>(env->GetPrimitiveArrayCritical(arr, nullptr));
        for (int c = 0; c < cpf; ++c) {
            const int gc = f * cpf + c;
            const uint8_t* s = src + c;
            // channel gc's elements: from `first` on, every `step`
            const size_t first = nhwc ? size_t(gc) : size_t(gc) * plane, step = nhwc ? size_t(C) : 1;
            if (u8) {
                uint8_t* d = xu.data() + first;
                for (size_t i = 0; i < plane; ++i) d[i * step] = s[i * cpf];
                continue;
            }
            // v * scale + bias for each of the 256 byte values, fused as clang always compiled it here (one rounding)
            const float scale = 1.f / (255.f * p[4 + 2 * gc + 1]), bias = -p[4 + 2 * gc] / p[4 + 2 * gc + 1];
            float lut[256];
            for (int v = 0; v < 256; ++v) lut[v] = std::fma(float(v), scale, bias);
            float* d = xf.data() + first;
            if (step == 1 && cpf == 3) {
                for (size_t i = 0; i < plane; ++i) d[i] = lut[s[i * 3]];
            }
            else {
                for (size_t i = 0; i < plane; ++i) d[i * step] = lut[s[i * cpf]];
            }
        }
        env->ReleasePrimitiveArrayCritical(arr, src, JNI_ABORT);
        env->DeleteLocalRef(arr);
    }
    std::vector<int64_t> shape = in.dims;
    if (shape.size() == 4) {
        shape = nhwc ? std::vector<int64_t> { 1, hh, w, C } : std::vector<int64_t> { 1, C, hh, w };
    }
    else if (shape.size() == 3) {
        shape = nhwc ? std::vector<int64_t> { hh, w, C } : std::vector<int64_t> { C, hh, w };
    }
    else {
        throw_java(env, "infer: the model's input must be 3- or 4-dimensional");
        return nullptr;
    }
    const OrtApi* api = m->rt->api;
    OrtValue* x = nullptr;
    OrtStatus* st = u8 ? api->CreateTensorWithDataAsOrtValue(m->rt->mem, xu.data(), xu.size(), shape.data(), shape.size(),
                                                               ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8, &x)
                       : api->CreateTensorWithDataAsOrtValue(m->rt->mem, xf.data(), xf.size() * 4, shape.data(), shape.size(),
                                                               ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &x);
    if (failed(env, api, st, "infer")) return nullptr;
    return x;
}

// nnRun's return encoding: [n outputs, per output: rank, dims..., then every output's data], all as float. Null (with
// a Java exception) on failure; the values are not released.
jfloatArray encode_outputs(JNIEnv* env, const OrtApi* api, const std::vector<OrtValue*>& outs)
{
    std::vector<float> res { float(outs.size()) };
    std::vector<float> data;
    OrtStatus* st = nullptr;
    for (size_t i = 0; !st && i < outs.size(); ++i) {
        OrtTensorTypeAndShapeInfo* info = nullptr;
        st = api->GetTensorTypeAndShape(outs[i], &info);
        if (st) break;
        ONNXTensorElementDataType et;
        size_t rank = 0, count = 0;
        api->GetTensorElementType(info, &et);
        api->GetDimensionsCount(info, &rank);
        std::vector<int64_t> dims(rank);
        api->GetDimensions(info, dims.data(), rank);
        api->GetTensorShapeElementCount(info, &count);
        api->ReleaseTensorTypeAndShapeInfo(info);
        res.push_back(float(rank));
        for (int64_t d : dims) res.push_back(float(d));
        void* raw = nullptr;
        st = api->GetTensorMutableData(outs[i], &raw);
        if (st) break;
        const size_t at = data.size();
        data.resize(at + count);
        switch (et) {
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT:
            std::memcpy(data.data() + at, raw, count * 4);
            break;
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8:
            for (size_t k = 0; k < count; ++k) data[at + k] = static_cast<uint8_t*>(raw)[k];
            break;
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32:
            for (size_t k = 0; k < count; ++k) data[at + k] = float(static_cast<int32_t*>(raw)[k]);
            break;
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64:
            for (size_t k = 0; k < count; ++k) data[at + k] = float(static_cast<int64_t*>(raw)[k]);
            break;
        default:
            std::fill(data.begin() + at, data.end(), NAN);
        }
    }
    if (failed(env, api, st, "infer")) return nullptr;
    res.insert(res.end(), data.begin(), data.end());
    jfloatArray arr = env->NewFloatArray(jsize(res.size()));
    env->SetFloatArrayRegion(arr, 0, jsize(res.size()), res.data());
    return arr;
}

} // namespace

#define FN(ret, name) extern "C" JNIEXPORT ret JNICALL Java_io_github_flufy3d_maalow_engine_Maa_##name

// Load the QNN plugin's onnxruntime from dir (the plugin APK's nativeLibraryDir: libonnxruntime.so with the QNN
// execution provider, libQnnHtp.so and friends). Once loaded it stays; a later call with another dir is refused
// (the app restarts to pick up a reinstalled plugin). Returns "" when loaded, else why not.
FN(jstring, nnQnnLoad)(JNIEnv* env, jobject, jstring jdir)
{
    // MaaFramework's runtime first: it must stay the one found by name (see the top of this file).
    if (!init()) {
        return env->NewStringUTF(("onnxruntime: " + g_maa.error).c_str());
    }
    const char* p = env->GetStringUTFChars(jdir, nullptr);
    std::string dir = p;
    env->ReleaseStringUTFChars(jdir, p);
    std::lock_guard<std::mutex> lock(g_qnn_lock);
    if (g_qnn.api) {
        return env->NewStringUTF(dir == g_qnn_dir ? "" : ("already loaded from " + g_qnn_dir).c_str());
    }
    // The HTP skel (libQnnHtpV**Skel.so) is a DSP library: FastRPC (libcdsprpc.so, in this process) reads it from a
    // directory on ADSP_LIBRARY_PATH and pushes it to the cDSP. The plugin's lib dir first, then the system's.
    std::string adsp = dir + ";/vendor/dsp/cdsp;/vendor/lib/rfsa/adsp;/system/lib/rfsa/adsp;/dsp";
    setenv("ADSP_LIBRARY_PATH", adsp.c_str(), 1);
    // QNN's libraries dlopen() each other by bare name (libQnnHtp.so -> libQnnHtpV73Stub.so, libQnnHtpPrepare.so;
    // onnxruntime -> libQnnSystem.so), which our linker namespace cannot find in another APK's directory. Loaded here
    // by path first, a later by-name dlopen() finds them by soname. One the plugin left out (an HTP version) is
    // skipped. The stubs need libcdsprpc.so: uses-native-library in the app's manifest.
    std::string errors;
    for (const char* name : { "libQnnSystem.so", "libQnnHtpPrepare.so", "libQnnHtp.so", "libQnnHtpV68Stub.so", "libQnnHtpV69Stub.so",
                              "libQnnHtpV73Stub.so", "libQnnHtpV75Stub.so", "libQnnHtpV79Stub.so", "libQnnHtpV81Stub.so" }) {
        std::string path = dir + "/" + name;
        if (access(path.c_str(), R_OK) != 0) {
            continue;
        }
        if (!dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL)) {
            const char* e = dlerror();
            errors += std::string(errors.empty() ? "" : "; ") + (e ? e : name);
        }
    }
    if (!errors.empty()) {
        return env->NewStringUTF(("qnn libraries: " + errors).c_str());
    }
    std::string ort = dir + "/libonnxruntime.so";
    void* lib = dlopen(ort.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!lib) {
        const char* e = dlerror();
        return env->NewStringUTF((std::string("plugin onnxruntime: ") + (e ? e : "dlopen failed")).c_str());
    }
    Rt rt;
    if (!open_rt(lib, "plugin OrtGetApiBase", rt)) {
        return env->NewStringUTF(("plugin onnxruntime: " + rt.error).c_str());
    }
    g_qnn = rt;
    g_qnn_dir = dir;
    return env->NewStringUTF("");
}

// The plugin onnxruntime's version ("" when not loaded).
FN(jstring, nnQnnVersion)(JNIEnv* env, jobject)
{
    std::lock_guard<std::mutex> lock(g_qnn_lock);
    return env->NewStringUTF(g_qnn.api ? g_qnn.version.c_str() : "");
}

// A session for an .onnx file. opts: [intra-op threads, spin (0/1), provider (0 cpu, 1 nnapi, 2 qnn)]. cpu and nnapi
// run on MaaFramework's onnxruntime, qnn on the plugin's (nnQnnLoad first) with the HTP backend and every node on the
// NPU: no CPU fallback inside, so a model with an op QNN cannot take fails here (and Nn.kt falls back to cpu). Throws.
FN(jlong, nnCreate)(JNIEnv* env, jobject, jstring path, jintArray opts)
{
    if (!init()) {
        throw_java(env, "onnxruntime: " + g_maa.error);
        return 0;
    }
    jint o[3] = { 1, 0, 0 };
    env->GetIntArrayRegion(opts, 0, std::min<jsize>(3, env->GetArrayLength(opts)), o);
    if (o[2] < 0 || o[2] > 2) {
        throw_java(env, "onnxruntime: unknown provider " + std::to_string(o[2]));
        return 0;
    }
    const bool qnn = o[2] == 2;
    const Rt* rt = &g_maa;
    std::string backend;
    if (qnn) {
        std::lock_guard<std::mutex> lock(g_qnn_lock);
        if (!g_qnn.api) {
            throw_java(env, "onnxruntime: the QNN plugin is not loaded");
            return 0;
        }
        rt = &g_qnn;
        backend = g_qnn_dir + "/libQnnHtp.so";
    }
    const OrtApi* api = rt->api;
    const char* p = env->GetStringUTFChars(path, nullptr);
    std::string file = p;
    env->ReleaseStringUTFChars(path, p);

    OrtSessionOptions* so = nullptr;
    if (failed(env, api, api->CreateSessionOptions(&so), "session options")) {
        return 0;
    }
    OrtStatus* st = api->SetIntraOpNumThreads(so, std::max(1, int(o[0])));
    if (!st) st = api->SetInterOpNumThreads(so, 1);
    if (!st) st = api->SetSessionExecutionMode(so, ORT_SEQUENTIAL);
    if (!st) st = api->SetSessionGraphOptimizationLevel(so, ORT_ENABLE_ALL);
    if (!st) st = api->AddSessionConfigEntry(so, "session.intra_op.allow_spinning", o[1] ? "1" : "0");
    if (!st && o[2] == 1) {
        if (!g_nnapi) {
            api->ReleaseSessionOptions(so);
            throw_java(env, "onnxruntime: no NNAPI provider");
            return 0;
        }
        st = g_nnapi(so, 0);
    }
    if (!st && qnn) {
        st = api->AddSessionConfigEntry(so, "session.disable_cpu_ep_fallback", "1");
        // HTP backend by path; float32 models run in fp16 on it; a QDQ model's input quantization stays on the NPU
        const char* keys[] = { "backend_path", "htp_performance_mode", "enable_htp_fp16_precision", "offload_graph_io_quantization" };
        const char* vals[] = { backend.c_str(), "high_performance", "1", "0" };
        if (!st) st = api->SessionOptionsAppendExecutionProvider(so, "QNN", keys, vals, 4);
    }
    auto* m = new Model;
    m->rt = rt;
    if (!st) st = api->CreateSession(rt->env, file.c_str(), so, &m->session);
    api->ReleaseSessionOptions(so);
    if (!st) st = read_tensors(api, m->session, true, m->inputs);
    if (!st) st = read_tensors(api, m->session, false, m->outputs);
    if (st) {
        if (m->session) api->ReleaseSession(m->session);
        delete m;
        failed(env, api, st, qnn ? "onnxruntime (qnn)" : "onnxruntime");
        return 0;
    }
    for (auto& t : m->inputs) m->in_names.push_back(t.name.c_str());
    for (auto& t : m->outputs) m->out_names.push_back(t.name.c_str());
    m->names_meta = names_metadata(api, m->session);
    return reinterpret_cast<jlong>(m);
}

FN(void, nnDestroy)(JNIEnv*, jobject, jlong h)
{
    auto* m = reinterpret_cast<Model*>(h);
    if (!m) return;
    m->rt->api->ReleaseSession(m->session);
    delete m;
}

// {"inputs": [{name, type, shape}], "outputs": [...], "names": "<metadata>"}; type: ONNX element type (1 float, 2 uint8)
FN(jstring, nnInfo)(JNIEnv* env, jobject, jlong h)
{
    auto* m = reinterpret_cast<Model*>(h);
    std::string o = "{\"inputs\":" + tensors_json(m->inputs) + ",\"outputs\":" + tensors_json(m->outputs) + ",\"names\":\"" +
                    json_escape(m->names_meta) + "\"}";
    return env->NewStringUTF(o.c_str());
}

// p: [roi x, y, w, h, out w, out h, color (0 gray, 1 rgb, 2 bgr), interp (0 area, 1 linear, 2 nearest)] (nn_prep.h).
// HWC bytes, or null when the image is empty or the roi is not inside it. Written into `into` and returned when it is
// given with exactly that size (a buffer the caller reuses), else in a new array.
FN(jbyteArray, nnPrep)(JNIEnv* env, jobject, jlong image, jintArray params, jbyteArray into)
{
    jint p[8];
    if (env->GetArrayLength(params) < 8) return nullptr;
    env->GetIntArrayRegion(params, 0, 8, p);
    auto* img = reinterpret_cast<MaaImageBuffer*>(image);
    if (!img || MaaImageBufferIsEmpty(img) || MaaImageBufferChannels(img) != 3) return nullptr;
    const int w = MaaImageBufferWidth(img), h = MaaImageBufferHeight(img);
    const auto* data = static_cast<const uint8_t*>(MaaImageBufferGetRawData(img));
    if (!data || p[0] < 0 || p[1] < 0 || p[2] <= 0 || p[3] <= 0 || p[0] + p[2] > w || p[1] + p[3] > h || p[4] <= 0 || p[5] <= 0) {
        return nullptr;
    }
    const int ch = p[6] == 0 ? 1 : 3;
    const size_t n = size_t(p[4]) * p[5] * ch;
    thread_local std::vector<uint8_t> out;
    out.resize(n);
    nnprep::prep(data, size_t(w) * 3, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], out.data());
    jbyteArray res = into && size_t(env->GetArrayLength(into)) == n ? into : env->NewByteArray(jsize(n));
    env->SetByteArrayRegion(res, 0, jsize(n), reinterpret_cast<const jbyte*>(out.data()));
    return res;
}

// Run the model's first input on frames (each HWC uint8, `cpf` channels, w x h), stacked as channels in order.
// p: [w, h, cpf, layout (0 nchw, 1 nhwc), then per stacked channel: mean, std (value = (v / 255 - mean) / std;
// uint8 inputs get v as is)]. Returns [n outputs, per output: rank, dims..., then every output's data] (as float),
// or throws.
FN(jfloatArray, nnRun)(JNIEnv* env, jobject, jlong h, jobjectArray frames, jfloatArray params)
{
    auto* m = reinterpret_cast<Model*>(h);
    const OrtApi* api = m->rt->api;
    std::vector<float> p(env->GetArrayLength(params));
    env->GetFloatArrayRegion(params, 0, jsize(p.size()), p.data());
    std::vector<float> xf;
    std::vector<uint8_t> xu;
    OrtValue* x = image_input(env, m, frames, p, xf, xu);
    if (!x) return nullptr;
    std::vector<OrtValue*> outs(m->outputs.size(), nullptr);
    OrtStatus* st = api->Run(m->session, nullptr, m->in_names.data(), &x, 1, m->out_names.data(), outs.size(), outs.data());
    api->ReleaseValue(x);
    jfloatArray res = failed(env, api, st, "infer") ? nullptr : encode_outputs(env, api, outs);
    for (OrtValue* v : outs) {
        if (v) api->ReleaseValue(v);
    }
    return res;
}

// Run like nnRun, with the model's inputs[1..] from extras, in order: [n, then per tensor: rank, dims..., count,
// data...], all float (float32 tensors), n equal to the model's inputs beyond the image. Names are matched by Nn.kt,
// so the mapping here is positional; Run uses m->in_names as is. Returns the same encoding as nnRun, or throws.
// A model with no image input (a head that takes only its extra tensors) is run with `frames` empty: no image is
// built (params / the frames are ignored), the extras are its inputs[0..] instead and n is its whole input count.
FN(jfloatArray, nnRunExtra)(JNIEnv* env, jobject, jlong h, jobjectArray frames, jfloatArray params, jfloatArray extras)
{
    auto* m = reinterpret_cast<Model*>(h);
    const OrtApi* api = m->rt->api;
    const bool no_image = env->GetArrayLength(frames) == 0;
    std::vector<float> p(env->GetArrayLength(params));
    env->GetFloatArrayRegion(params, 0, jsize(p.size()), p.data());
    std::vector<float> e(env->GetArrayLength(extras));
    env->GetFloatArrayRegion(extras, 0, jsize(e.size()), e.data());
    size_t at = 0;
    const int n = e.empty() ? 0 : int(e[at++]);
    if (n <= 0 || m->inputs.empty() || size_t(n) != m->inputs.size() - (no_image ? 0 : 1)) {
        throw_java(env, "infer: bad extra inputs");
        return nullptr;
    }
    std::vector<std::vector<int64_t>> dims(n);
    std::vector<std::vector<float>> data(n);
    for (int i = 0; i < n; ++i) {
        if (at >= e.size()) {
            throw_java(env, "infer: bad extra inputs");
            return nullptr;
        }
        const int rank = int(e[at++]);
        if (rank < 0 || at + size_t(rank) + 1 > e.size()) {
            throw_java(env, "infer: bad extra inputs");
            return nullptr;
        }
        dims[i].resize(rank);
        for (int r = 0; r < rank; ++r) dims[i][r] = int64_t(e[at++]);
        const size_t count = size_t(e[at++]);
        if (at + count > e.size()) {
            throw_java(env, "infer: bad extra inputs");
            return nullptr;
        }
        data[i].assign(e.begin() + at, e.begin() + at + count);
        at += count;
    }
    std::vector<float> xf;
    std::vector<uint8_t> xu;
    std::vector<OrtValue*> vals;
    if (!no_image) {
        OrtValue* x = image_input(env, m, frames, p, xf, xu);
        if (!x) return nullptr;
        vals.push_back(x);
    }
    OrtStatus* st = nullptr;
    for (int i = 0; !st && i < n; ++i) {
        OrtValue* v = nullptr;
        st = api->CreateTensorWithDataAsOrtValue(m->rt->mem, data[i].data(), data[i].size() * 4, dims[i].data(), dims[i].size(),
                                                   ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &v);
        if (!st) vals.push_back(v);
    }
    if (failed(env, api, st, "infer")) {
        for (OrtValue* v : vals) api->ReleaseValue(v);
        return nullptr;
    }
    std::vector<OrtValue*> outs(m->outputs.size(), nullptr);
    st = api->Run(m->session, nullptr, m->in_names.data(), vals.data(), vals.size(), m->out_names.data(), outs.size(), outs.data());
    for (OrtValue* v : vals) api->ReleaseValue(v);
    if (failed(env, api, st, "infer")) {
        for (OrtValue* v : outs) {
            if (v) api->ReleaseValue(v);
        }
        return nullptr;
    }
    jfloatArray res = encode_outputs(env, api, outs);
    for (OrtValue* v : outs) {
        if (v) api->ReleaseValue(v);
    }
    return res;
}

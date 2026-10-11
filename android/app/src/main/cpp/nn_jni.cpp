// JNI for skills' infer() (skill/Nn.kt): ONNX models run with the onnxruntime MaaFramework already ships
// (libonnxruntime.so 1.19.2, loaded by libMaaFramework.so; only its C API, through OrtGetApiBase), and the
// preprocessing of a screenshot region into a small image (crop, resize, color) that a run keeps as frame history.
//
// Sessions are created once per model file and kept by Nn.kt; nothing here keeps per-call state.

#include <dlfcn.h>
#include <jni.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "MaaFramework/MaaAPI.h"
#include "onnxruntime_c_api.h"

namespace
{

const OrtApi* g_api = nullptr;
OrtEnv* g_env = nullptr;
OrtMemoryInfo* g_mem = nullptr;
std::string g_init_error;

using AppendNnapi = OrtStatus* (*)(OrtSessionOptions*, uint32_t);
AppendNnapi g_nnapi = nullptr;

bool init()
{
    static std::once_flag once;
    std::call_once(once, [] {
        void* lib = dlopen("libonnxruntime.so", RTLD_NOW | RTLD_NOLOAD);
        if (!lib) {
            lib = dlopen("libonnxruntime.so", RTLD_NOW);
        }
        auto get = lib ? reinterpret_cast<const OrtApiBase* (*)()>(dlsym(lib, "OrtGetApiBase")) : nullptr;
        if (!get) {
            g_init_error = "libonnxruntime.so not found";
            return;
        }
        g_api = get()->GetApi(ORT_API_VERSION);
        if (!g_api) {
            g_init_error = std::string("onnxruntime ") + get()->GetVersionString() + " lacks API version " +
                           std::to_string(ORT_API_VERSION);
            return;
        }
        g_nnapi = reinterpret_cast<AppendNnapi>(dlsym(lib, "OrtSessionOptionsAppendExecutionProvider_Nnapi"));
        OrtStatus* st = g_api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "maalow", &g_env);
        if (!st) {
            st = g_api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &g_mem);
        }
        if (st) {
            g_init_error = g_api->GetErrorMessage(st);
            g_api->ReleaseStatus(st);
            g_api = nullptr;
        }
    });
    return g_api != nullptr;
}

void throw_java(JNIEnv* env, const std::string& msg)
{
    env->ThrowNew(env->FindClass("java/lang/RuntimeException"), msg.c_str());
}

// An OrtStatus as a Java exception; true when there was an error.
bool failed(JNIEnv* env, OrtStatus* st, const char* what)
{
    if (!st) {
        return false;
    }
    throw_java(env, std::string(what) + ": " + g_api->GetErrorMessage(st));
    g_api->ReleaseStatus(st);
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

OrtStatus* read_tensors(OrtSession* s, bool input, std::vector<Tensor>& out)
{
    OrtAllocator* alloc = nullptr;
    OrtStatus* st = g_api->GetAllocatorWithDefaultOptions(&alloc);
    size_t n = 0;
    if (!st) {
        st = input ? g_api->SessionGetInputCount(s, &n) : g_api->SessionGetOutputCount(s, &n);
    }
    for (size_t i = 0; !st && i < n; ++i) {
        char* name = nullptr;
        st = input ? g_api->SessionGetInputName(s, i, alloc, &name) : g_api->SessionGetOutputName(s, i, alloc, &name);
        if (st) {
            break;
        }
        Tensor t;
        t.name = name;
        g_api->AllocatorFree(alloc, name);
        OrtTypeInfo* ti = nullptr;
        st = input ? g_api->SessionGetInputTypeInfo(s, i, &ti) : g_api->SessionGetOutputTypeInfo(s, i, &ti);
        if (st) {
            break;
        }
        const OrtTensorTypeAndShapeInfo* tsi = nullptr;
        if (!g_api->CastTypeInfoToTensorInfo(ti, &tsi) && tsi) {
            ONNXTensorElementDataType et;
            size_t rank = 0;
            g_api->GetTensorElementType(tsi, &et);
            g_api->GetDimensionsCount(tsi, &rank);
            t.type = int(et);
            t.dims.resize(rank);
            g_api->GetDimensions(tsi, t.dims.data(), rank);
        }
        g_api->ReleaseTypeInfo(ti);
        out.push_back(std::move(t));
    }
    return st;
}

std::string names_metadata(OrtSession* s)
{
    OrtModelMetadata* md = nullptr;
    if (g_api->SessionGetModelMetadata(s, &md)) {
        return "";
    }
    std::string out;
    OrtAllocator* alloc = nullptr;
    char* v = nullptr;
    if (!g_api->GetAllocatorWithDefaultOptions(&alloc) && !g_api->ModelMetadataLookupCustomMetadataMap(md, alloc, "names", &v) && v) {
        out = v;
        g_api->AllocatorFree(alloc, v);
    }
    g_api->ReleaseModelMetadata(md);
    return out;
}

// ---- preprocessing

// OpenCV's INTER_AREA weights (computeResizeAreaTab): per output index, (source index, weight) pairs.
struct Tap
{
    int src;
    float w;
};

std::vector<std::vector<Tap>> area_taps(int ssize, int dsize)
{
    const double scale = double(ssize) / dsize;
    std::vector<std::vector<Tap>> taps(dsize);
    for (int dx = 0; dx < dsize; ++dx) {
        double fsx1 = dx * scale, fsx2 = fsx1 + scale;
        double cell = std::min(scale, ssize - fsx1);
        int sx1 = int(std::ceil(fsx1)), sx2 = int(std::floor(fsx2));
        sx2 = std::min(sx2, ssize - 1);
        sx1 = std::min(sx1, sx2);
        auto& t = taps[dx];
        if (sx1 - fsx1 > 1e-3) {
            t.push_back({ sx1 - 1, float((sx1 - fsx1) / cell) });
        }
        for (int sx = sx1; sx < sx2; ++sx) {
            t.push_back({ sx, float(1.0 / cell) });
        }
        if (fsx2 - sx2 > 1e-3) {
            t.push_back({ sx2, float(std::min(std::min(fsx2 - sx2, 1.0), cell) / cell) });
        }
    }
    return taps;
}

// Bilinear (OpenCV INTER_LINEAR: half-pixel centers, edges clamped) or nearest (floor(dx * scale)).
std::vector<std::vector<Tap>> point_taps(int ssize, int dsize, bool linear)
{
    const double scale = double(ssize) / dsize;
    std::vector<std::vector<Tap>> taps(dsize);
    for (int dx = 0; dx < dsize; ++dx) {
        if (!linear) {
            taps[dx].push_back({ std::min(int(dx * scale), ssize - 1), 1.f });
            continue;
        }
        double f = (dx + 0.5) * scale - 0.5;
        int x0 = int(std::floor(f));
        float a = float(f - x0);
        if (x0 < 0) {
            x0 = 0;
            a = 0;
        }
        if (x0 >= ssize - 1) {
            x0 = ssize - 1;
            a = 0;
        }
        taps[dx].push_back({ x0, 1.f - a });
        if (a > 0) {
            taps[dx].push_back({ x0 + 1, a });
        }
    }
    return taps;
}

inline uint8_t sat(float v)
{
    int i = int(std::lround(v));
    return uint8_t(std::clamp(i, 0, 255));
}

// Crop roi of a BGR image, resize to ow x oh (interp 0 area, 1 linear, 2 nearest; area upscaling is linear, as in
// OpenCV), then color 0 gray (cv::COLOR_BGR2GRAY's fixed point), 1 rgb, 2 bgr. Out: HWC, 1 or 3 channels.
void prep(const uint8_t* img, int stride, int rx, int ry, int rw, int rh, int ow, int oh, int color, int interp, uint8_t* out)
{
    const bool area = interp == 0;
    auto tx = area && rw >= ow ? area_taps(rw, ow) : point_taps(rw, ow, interp != 2);
    auto ty = area && rh >= oh ? area_taps(rh, oh) : point_taps(rh, oh, interp != 2);
    std::vector<float> row(size_t(ow) * 3);
    std::vector<float> acc(size_t(ow) * 3);
    std::vector<uint8_t> bgr(size_t(ow) * 3);
    for (int dy = 0; dy < oh; ++dy) {
        std::fill(acc.begin(), acc.end(), 0.f);
        for (const Tap& vy : ty[dy]) {
            const uint8_t* src = img + size_t(ry + vy.src) * stride + size_t(rx) * 3;
            for (int dx = 0; dx < ow; ++dx) {
                float b = 0, g = 0, r = 0;
                for (const Tap& vx : tx[dx]) {
                    const uint8_t* p = src + vx.src * 3;
                    b += p[0] * vx.w;
                    g += p[1] * vx.w;
                    r += p[2] * vx.w;
                }
                acc[dx * 3] += b * vy.w;
                acc[dx * 3 + 1] += g * vy.w;
                acc[dx * 3 + 2] += r * vy.w;
            }
        }
        for (int i = 0; i < ow * 3; ++i) {
            bgr[i] = sat(acc[i]);
        }
        uint8_t* o = out + size_t(dy) * ow * (color == 0 ? 1 : 3);
        for (int dx = 0; dx < ow; ++dx) {
            const uint8_t b = bgr[dx * 3], g = bgr[dx * 3 + 1], r = bgr[dx * 3 + 2];
            if (color == 0) {
                o[dx] = uint8_t((b * 1868 + g * 9617 + r * 4899 + (1 << 13)) >> 14);
            }
            else if (color == 1) {
                o[dx * 3] = r;
                o[dx * 3 + 1] = g;
                o[dx * 3 + 2] = b;
            }
            else {
                o[dx * 3] = b;
                o[dx * 3 + 1] = g;
                o[dx * 3 + 2] = r;
            }
        }
    }
}

} // namespace

#define FN(ret, name) extern "C" JNIEXPORT ret JNICALL Java_io_github_flufy3d_maalow_engine_Maa_##name

// A session for an .onnx file. opts: [intra-op threads, spin (0/1), nnapi (0/1)]. Throws on failure.
FN(jlong, nnCreate)(JNIEnv* env, jobject, jstring path, jintArray opts)
{
    if (!init()) {
        throw_java(env, "onnxruntime: " + g_init_error);
        return 0;
    }
    jint o[3] = { 1, 0, 0 };
    env->GetIntArrayRegion(opts, 0, std::min<jsize>(3, env->GetArrayLength(opts)), o);
    const char* p = env->GetStringUTFChars(path, nullptr);
    std::string file = p;
    env->ReleaseStringUTFChars(path, p);

    OrtSessionOptions* so = nullptr;
    if (failed(env, g_api->CreateSessionOptions(&so), "session options")) {
        return 0;
    }
    OrtStatus* st = g_api->SetIntraOpNumThreads(so, std::max(1, int(o[0])));
    if (!st) st = g_api->SetInterOpNumThreads(so, 1);
    if (!st) st = g_api->SetSessionExecutionMode(so, ORT_SEQUENTIAL);
    if (!st) st = g_api->SetSessionGraphOptimizationLevel(so, ORT_ENABLE_ALL);
    if (!st) st = g_api->AddSessionConfigEntry(so, "session.intra_op.allow_spinning", o[1] ? "1" : "0");
    if (!st && o[2]) {
        if (!g_nnapi) {
            g_api->ReleaseSessionOptions(so);
            throw_java(env, "onnxruntime: no NNAPI provider");
            return 0;
        }
        st = g_nnapi(so, 0);
    }
    auto* m = new Model;
    if (!st) st = g_api->CreateSession(g_env, file.c_str(), so, &m->session);
    g_api->ReleaseSessionOptions(so);
    if (!st) st = read_tensors(m->session, true, m->inputs);
    if (!st) st = read_tensors(m->session, false, m->outputs);
    if (st) {
        if (m->session) g_api->ReleaseSession(m->session);
        delete m;
        failed(env, st, "onnxruntime");
        return 0;
    }
    for (auto& t : m->inputs) m->in_names.push_back(t.name.c_str());
    for (auto& t : m->outputs) m->out_names.push_back(t.name.c_str());
    m->names_meta = names_metadata(m->session);
    return reinterpret_cast<jlong>(m);
}

FN(void, nnDestroy)(JNIEnv*, jobject, jlong h)
{
    auto* m = reinterpret_cast<Model*>(h);
    if (!m) return;
    g_api->ReleaseSession(m->session);
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

// p: [roi x, y, w, h, out w, out h, color (0 gray, 1 rgb, 2 bgr), interp (0 area, 1 linear, 2 nearest)].
// HWC bytes, or null when the image is empty or the roi is not inside it.
FN(jbyteArray, nnPrep)(JNIEnv* env, jobject, jlong image, jintArray params)
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
    std::vector<uint8_t> out(n);
    prep(data, w * 3, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], out.data());
    jbyteArray res = env->NewByteArray(jsize(n));
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
    const int nf = env->GetArrayLength(frames);
    std::vector<float> p(env->GetArrayLength(params));
    env->GetFloatArrayRegion(params, 0, jsize(p.size()), p.data());
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
    std::vector<float> xf(u8 ? 0 : plane * C);
    std::vector<uint8_t> xu(u8 ? plane * C : 0);
    for (int f = 0; f < nf; ++f) {
        auto arr = static_cast<jbyteArray>(env->GetObjectArrayElement(frames, f));
        if (size_t(env->GetArrayLength(arr)) < plane * cpf) {
            throw_java(env, "infer: frame size does not match");
            return nullptr;
        }
        auto* src = reinterpret_cast<uint8_t*>(env->GetPrimitiveArrayCritical(arr, nullptr));
        for (int c = 0; c < cpf; ++c) {
            const int gc = f * cpf + c;
            const float scale = 1.f / (255.f * p[4 + 2 * gc + 1]), bias = -p[4 + 2 * gc] / p[4 + 2 * gc + 1];
            for (size_t i = 0; i < plane; ++i) {
                const uint8_t v = src[i * cpf + c];
                const size_t at = nhwc ? i * C + gc : size_t(gc) * plane + i;
                if (u8) xu[at] = v;
                else xf[at] = v * scale + bias;
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
    OrtValue* x = nullptr;
    OrtStatus* st = u8 ? g_api->CreateTensorWithDataAsOrtValue(g_mem, xu.data(), xu.size(), shape.data(), shape.size(),
                                                               ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8, &x)
                       : g_api->CreateTensorWithDataAsOrtValue(g_mem, xf.data(), xf.size() * 4, shape.data(), shape.size(),
                                                               ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &x);
    if (failed(env, st, "infer")) return nullptr;
    std::vector<OrtValue*> outs(m->outputs.size(), nullptr);
    st = g_api->Run(m->session, nullptr, m->in_names.data(), &x, 1, m->out_names.data(), outs.size(), outs.data());
    g_api->ReleaseValue(x);
    std::vector<float> res { float(outs.size()) };
    std::vector<float> data;
    for (size_t i = 0; !st && i < outs.size(); ++i) {
        OrtTensorTypeAndShapeInfo* info = nullptr;
        st = g_api->GetTensorTypeAndShape(outs[i], &info);
        if (st) break;
        ONNXTensorElementDataType et;
        size_t rank = 0, count = 0;
        g_api->GetTensorElementType(info, &et);
        g_api->GetDimensionsCount(info, &rank);
        std::vector<int64_t> dims(rank);
        g_api->GetDimensions(info, dims.data(), rank);
        g_api->GetTensorShapeElementCount(info, &count);
        g_api->ReleaseTensorTypeAndShapeInfo(info);
        res.push_back(float(rank));
        for (int64_t d : dims) res.push_back(float(d));
        void* raw = nullptr;
        st = g_api->GetTensorMutableData(outs[i], &raw);
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
    for (OrtValue* v : outs) {
        if (v) g_api->ReleaseValue(v);
    }
    if (failed(env, st, "infer")) return nullptr;
    res.insert(res.end(), data.begin(), data.end());
    jfloatArray arr = env->NewFloatArray(jsize(res.size()));
    env->SetFloatArrayRegion(arr, 0, jsize(res.size()), res.data());
    return arr;
}

// JNI over QuickJS (quickjs-ng) for io.github.flufy3d.maalow.skill.Js.
//
// One runtime per skill run. Scripts see a single native function, __host(op, json) -> json, which calls
// Js.Host.call in Kotlin; the prelude builds the skill API on top of it. ES modules are loaded through
// Js.Host.module (workspace-relative names such as "skills/lib/util.js"). Strings cross JNI as UTF-8 byte arrays,
// since JNI's modified UTF-8 cannot carry characters outside the BMP.

#include <jni.h>

#include <android/log.h>

#include <atomic>
#include <cstring>
#include <string>

#include "quickjs.h"

#define LOG_TAG "MaaLowJs"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace
{

JavaVM* g_vm = nullptr;
jclass g_stop = nullptr;     // Js$Stop: host asks to end the run (uncatchable in script)
jmethodID g_call = nullptr;  // Js$Host.call(String, byte[]): byte[]
jmethodID g_module = nullptr; // Js$Host.module(byte[]): byte[]

constexpr size_t kMemoryLimit = 256 << 20;
constexpr size_t kStackLimit = 512 << 10; // below the ~1 MB of native worker threads

struct Runtime
{
    JSRuntime* rt = nullptr;
    JSContext* ctx = nullptr;
    jobject host = nullptr;
    std::atomic<bool> interrupted { false };
    int depth = 0; // nested calls (a skill calling another through the host)
};

JNIEnv* jenv()
{
    JNIEnv* env = nullptr;
    g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
    return env;
}

Runtime* runtime_of(JSContext* ctx)
{
    return static_cast<Runtime*>(JS_GetContextOpaque(ctx));
}

jbyteArray bytes(JNIEnv* env, const char* s, size_t len)
{
    jbyteArray a = env->NewByteArray(jsize(len));
    env->SetByteArrayRegion(a, 0, jsize(len), reinterpret_cast<const jbyte*>(s));
    return a;
}

std::string from_bytes(JNIEnv* env, jbyteArray a)
{
    if (!a) {
        return {};
    }
    std::string s(size_t(env->GetArrayLength(a)), '\0');
    env->GetByteArrayRegion(a, 0, jsize(s.size()), reinterpret_cast<jbyte*>(s.data()));
    return s;
}

// UTF-16 jstring to UTF-8 (surrogate pairs become 4-byte sequences).
std::string utf8(JNIEnv* env, jstring s)
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

// A pending Java exception from a host call, rethrown into the script. Js$Stop becomes uncatchable, so a
// try/catch in the script cannot swallow /stop or a timeout.
JSValue throw_java(JNIEnv* env, JSContext* ctx)
{
    jthrowable t = env->ExceptionOccurred();
    env->ExceptionClear();
    jclass cls = env->GetObjectClass(t);
    auto msg = static_cast<jstring>(env->CallObjectMethod(t, env->GetMethodID(cls, "getMessage", "()Ljava/lang/String;")));
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        msg = nullptr;
    }
    std::string text = msg ? utf8(env, msg) : "host error";
    bool stop = env->IsInstanceOf(t, g_stop);
    env->DeleteLocalRef(cls);
    env->DeleteLocalRef(t);
    JSValue err = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, err, "message", JS_NewStringLen(ctx, text.data(), text.size()), JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE);
    if (stop) {
        runtime_of(ctx)->interrupted = true;
        JS_DefinePropertyValueStr(ctx, err, "name", JS_NewString(ctx, "Stop"), JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE);
        JS_SetUncatchableError(ctx, err);
    }
    return JS_Throw(ctx, err);
}

JSValue js_host(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    Runtime* r = runtime_of(ctx);
    const char* op = argc > 0 ? JS_ToCString(ctx, argv[0]) : nullptr;
    if (!op) {
        return JS_EXCEPTION;
    }
    size_t len = 0;
    const char* args = argc > 1 && !JS_IsUndefined(argv[1]) ? JS_ToCStringLen(ctx, &len, argv[1]) : nullptr;
    JNIEnv* env = jenv();
    jstring jop = env->NewStringUTF(op);
    jbyteArray jargs = args ? bytes(env, args, len) : nullptr;
    JS_FreeCString(ctx, op);
    if (args) {
        JS_FreeCString(ctx, args);
    }
    auto out = static_cast<jbyteArray>(env->CallObjectMethod(r->host, g_call, jop, jargs));
    env->DeleteLocalRef(jop);
    if (jargs) {
        env->DeleteLocalRef(jargs);
    }
    if (env->ExceptionCheck()) {
        return throw_java(env, ctx);
    }
    if (!out) {
        return JS_UNDEFINED;
    }
    std::string s = from_bytes(env, out);
    env->DeleteLocalRef(out);
    return JS_NewStringLen(ctx, s.data(), s.size());
}

JSModuleDef* load_module(JSContext* ctx, const char* name, void*)
{
    Runtime* r = runtime_of(ctx);
    JNIEnv* env = jenv();
    jbyteArray jname = bytes(env, name, strlen(name));
    auto src = static_cast<jbyteArray>(env->CallObjectMethod(r->host, g_module, jname));
    env->DeleteLocalRef(jname);
    if (env->ExceptionCheck()) {
        throw_java(env, ctx);
        return nullptr;
    }
    std::string code = from_bytes(env, src); // std::string keeps the trailing NUL JS_Eval wants
    env->DeleteLocalRef(src);
    JSValue fn = JS_Eval(ctx, code.c_str(), code.size(), name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(fn)) {
        return nullptr;
    }
    auto* m = static_cast<JSModuleDef*>(JS_VALUE_GET_PTR(fn));
    JS_FreeValue(ctx, fn);
    return m;
}

int on_interrupt(JSRuntime*, void* opaque)
{
    return static_cast<Runtime*>(opaque)->interrupted.load(std::memory_order_relaxed) ? 1 : 0;
}

// Run jobs until the promise settles; returns its value, or JS_EXCEPTION with the rejection thrown.
JSValue settle(Runtime* r, JSValue v)
{
    JSContext* ctx = r->ctx;
    if (!JS_IsPromise(v)) {
        return v;
    }
    for (;;) {
        switch (JS_PromiseState(ctx, v)) {
        case JS_PROMISE_FULFILLED: {
            JSValue res = JS_PromiseResult(ctx, v);
            JS_FreeValue(ctx, v);
            return res;
        }
        case JS_PROMISE_REJECTED: {
            JSValue err = JS_PromiseResult(ctx, v);
            JS_FreeValue(ctx, v);
            return JS_Throw(ctx, err);
        }
        default:
            break;
        }
        JSContext* job_ctx = nullptr;
        int ret = JS_ExecutePendingJob(r->rt, &job_ctx);
        if (ret < 0) {
            JS_FreeValue(ctx, v);
            return JS_EXCEPTION;
        }
        if (ret == 0) {
            JS_FreeValue(ctx, v);
            return JS_ThrowInternalError(ctx, "promise never settles (skills have no timers; await only host calls)");
        }
    }
}

// {"ok":true,"value":...[,"missing":true]} or {"ok":false,"error":{"name","message","stack","interrupted"}}, as
// UTF-8 JSON. missing: the export asked for does not exist.
std::string envelope(Runtime* r, JSValue v, bool missing = false)
{
    JSContext* ctx = r->ctx;
    JSValue env = JS_NewObject(ctx);
    if (!JS_IsException(v)) {
        JS_SetPropertyStr(ctx, env, "ok", JS_TRUE);
        JS_SetPropertyStr(ctx, env, "value", v);
        if (missing) {
            JS_SetPropertyStr(ctx, env, "missing", JS_TRUE);
        }
    }
    else {
        JSValue exc = JS_GetException(ctx);
        JSValue err = JS_NewObject(ctx);
        if (JS_IsError(exc)) {
            JS_SetPropertyStr(ctx, err, "name", JS_GetPropertyStr(ctx, exc, "name"));
            JS_SetPropertyStr(ctx, err, "message", JS_GetPropertyStr(ctx, exc, "message"));
            JS_SetPropertyStr(ctx, err, "stack", JS_GetPropertyStr(ctx, exc, "stack"));
        }
        else {
            JS_SetPropertyStr(ctx, err, "name", JS_NewString(ctx, "Thrown"));
            JS_SetPropertyStr(ctx, err, "message", JS_ToString(ctx, exc));
        }
        bool interrupted = r->interrupted.load() || JS_IsUncatchableError(exc);
        JS_SetPropertyStr(ctx, err, "interrupted", JS_NewBool(ctx, interrupted));
        JS_FreeValue(ctx, exc);
        JS_SetPropertyStr(ctx, env, "ok", JS_FALSE);
        JS_SetPropertyStr(ctx, env, "error", err);
    }
    JSValue json = JS_JSONStringify(ctx, env, JS_UNDEFINED, JS_UNDEFINED);
    JS_FreeValue(ctx, env);
    std::string out;
    if (JS_IsException(json)) { // e.g. a cyclic return value
        JS_FreeValue(ctx, JS_GetException(ctx));
        out = R"({"ok":false,"error":{"name":"TypeError","message":"result is not JSON-serializable"}})";
    }
    else {
        size_t len = 0;
        const char* s = JS_ToCStringLen(ctx, &len, json);
        out.assign(s, len);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, json);
    return out;
}

JSValue parse(JSContext* ctx, const std::string& json, const char* what)
{
    return json.empty() ? JS_UNDEFINED : JS_ParseJSON(ctx, json.c_str(), json.size(), what);
}

Runtime* ptr(jlong h)
{
    return reinterpret_cast<Runtime*>(h);
}

void destroy(JNIEnv* env, Runtime* r)
{
    if (r->ctx) {
        JS_FreeContext(r->ctx);
    }
    if (r->rt) {
        JS_FreeRuntime(r->rt);
    }
    if (r->host) {
        env->DeleteGlobalRef(r->host);
    }
    delete r;
}

} // namespace

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*)
{
    g_vm = vm;
    JNIEnv* env = jenv();
    jclass host = env->FindClass("io/github/flufy3d/maalow/skill/Js$Host");
    jclass stop = env->FindClass("io/github/flufy3d/maalow/skill/Js$Stop");
    if (!host || !stop) {
        LOGE("Js classes not found");
        return JNI_ERR;
    }
    g_call = env->GetMethodID(host, "call", "(Ljava/lang/String;[B)[B");
    g_module = env->GetMethodID(host, "module", "([B)[B");
    g_stop = static_cast<jclass>(env->NewGlobalRef(stop));
    return JNI_VERSION_1_6;
}

#define FN(ret, name) extern "C" JNIEXPORT ret JNICALL Java_io_github_flufy3d_maalow_skill_Js_##name

// A runtime with the host function and the prelude (a global script) evaluated. Throws IllegalStateException
// with the prelude's error.
FN(jlong, create)(JNIEnv* env, jobject, jobject host, jbyteArray prelude, jstring prelude_name)
{
    auto* r = new Runtime;
    r->rt = JS_NewRuntime();
    JS_SetMemoryLimit(r->rt, kMemoryLimit);
    JS_SetMaxStackSize(r->rt, kStackLimit);
    JS_SetInterruptHandler(r->rt, on_interrupt, r);
    JS_SetModuleLoaderFunc(r->rt, nullptr, load_module, r);
    r->ctx = JS_NewContext(r->rt);
    JS_SetContextOpaque(r->ctx, r);
    r->host = env->NewGlobalRef(host);

    JSValue global = JS_GetGlobalObject(r->ctx);
    JS_SetPropertyStr(r->ctx, global, "__host", JS_NewCFunction(r->ctx, js_host, "__host", 2));
    JS_FreeValue(r->ctx, global);
    std::string src = from_bytes(env, prelude);
    std::string name = utf8(env, prelude_name);
    JSValue v = JS_Eval(r->ctx, src.c_str(), src.size(), name.c_str(), JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    if (JS_IsException(v)) {
        std::string err = envelope(r, v);
        destroy(env, r);
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), err.c_str());
        return 0;
    }
    JS_FreeValue(r->ctx, v);
    return reinterpret_cast<jlong>(r);
}

FN(void, destroy)(JNIEnv* env, jobject, jlong h)
{
    destroy(env, ptr(h));
}

// Import a module and take one of its exports: a function is called with (args, ctx) and its (awaited) result
// returned; any other value is returned as is; "*" gives the export names. Result: the envelope JSON as UTF-8.
FN(jbyteArray, call)(JNIEnv* env, jobject, jlong h, jstring module, jstring name, jbyteArray args, jbyteArray ctx_json)
{
    Runtime* r = ptr(h);
    JSContext* ctx = r->ctx;
    if (r->depth++ == 0) {
        JS_UpdateStackTop(r->rt); // the outermost call on this thread sets where the stack limit counts from
    }
    std::string mod = utf8(env, module);
    std::string key = utf8(env, name);
    JSValue result;
    bool missing = false;
    JSValue ns = settle(r, JS_LoadModule(ctx, "", mod.c_str()));
    if (JS_IsException(ns)) {
        result = JS_EXCEPTION;
    }
    else if (key == "*") { // the export names
        JSPropertyEnum* tab = nullptr;
        uint32_t len = 0;
        if (JS_GetOwnPropertyNames(ctx, &tab, &len, ns, JS_GPN_STRING_MASK) < 0) {
            result = JS_EXCEPTION;
        }
        else {
            result = JS_NewArray(ctx);
            for (uint32_t i = 0; i < len; ++i) {
                JS_SetPropertyUint32(ctx, result, i, JS_AtomToValue(ctx, tab[i].atom));
            }
            JS_FreePropertyEnum(ctx, tab, len);
        }
        JS_FreeValue(ctx, ns);
    }
    else {
        JSValue val = JS_GetPropertyStr(ctx, ns, key.c_str());
        JS_FreeValue(ctx, ns);
        if (JS_IsException(val) || !JS_IsFunction(ctx, val)) {
            missing = JS_IsUndefined(val);
            result = val;
        }
        else {
            JSValue argv[2] = { parse(ctx, from_bytes(env, args), "args"), parse(ctx, from_bytes(env, ctx_json), "ctx") };
            if (JS_IsException(argv[0]) || JS_IsException(argv[1])) {
                result = JS_EXCEPTION;
            }
            else {
                result = settle(r, JS_Call(ctx, val, JS_UNDEFINED, 2, argv));
            }
            JS_FreeValue(ctx, argv[0]);
            JS_FreeValue(ctx, argv[1]);
            JS_FreeValue(ctx, val);
        }
    }
    std::string out = envelope(r, result, missing);
    r->depth--;
    return bytes(env, out.data(), out.size());
}

// Ask running script code to stop at the next check (on: true), or clear the request.
FN(void, interrupt)(JNIEnv*, jobject, jlong h, jboolean on)
{
    ptr(h)->interrupted = on;
}

// The optional QNN plugin: a separate APK (io.github.flufy3d.maalow.qnn) that only carries native libraries for the
// main app to load (skill/QnnPlugin.kt, nn_jni.cpp): onnxruntime with the QNN execution provider (Microsoft's
// onnxruntime-android-qnn, MIT) and Qualcomm's QNN runtime it was built against (com.qualcomm.qti:qnn-runtime, under
// Qualcomm's AI Hub Model License, shipped in assets/licenses/). No code, no activity; it does not depend on :app and
// :app does not depend on it. Built and released on its own: ./gradlew :qnnplugin:assembleRelease.
plugins {
    id("com.android.application")
}

val ortVersion = "1.29.0"
val qnnVersion = "2.42.0" // the qnn-runtime onnxruntime-android-qnn $ortVersion declares

// HTP (NPU) generations kept, as libQnnHtpV<nn>Stub.so (CPU side) + libQnnHtpV<nn>Skel.so (DSP side):
// V69 Snapdragon 8 Gen 1 / 8+ Gen 1, V73 8 Gen 2, V75 8 Gen 3, V79 8 Elite; the 7+ / 8s parts of those years use one of
// these four (libQnnHtp.so picks the one for the chip it runs on). Left out: V68 (888 era) and V81 (8 Elite Gen 5),
// about 10 and 18 MB more uncompressed: add them here if a device needs them.
val htpVersions = listOf("V69", "V73", "V75", "V79")
val keptLibs = listOf(
    "libonnxruntime.so", // with the QNN EP built in; libonnxruntime4j_jni.so (its Java binding) is not needed
    "libQnnHtp.so", // HTP backend
    "libQnnHtpPrepare.so", // compiles an ONNX graph for the HTP on the device (not needed by precompiled EPContext models)
    "libQnnSystem.so",
) + htpVersions.flatMap { listOf("libQnnHtp${it}Stub.so", "libQnnHtp${it}Skel.so") }

val qnnRuntime: Configuration by configurations.creating {
    isCanBeConsumed = false
    isTransitive = false
}

dependencies {
    qnnRuntime("com.microsoft.onnxruntime:onnxruntime-android-qnn:$ortVersion@aar")
    qnnRuntime("com.qualcomm.qti:qnn-runtime:$qnnVersion@aar")
}

val qnnLibs = layout.buildDirectory.dir("qnn/jniLibs")
val qnnLicenses = layout.buildDirectory.dir("qnn/assets")

val unpackQnnLibs by tasks.registering(Sync::class) {
    from(qnnRuntime.elements.map { files -> files.map { zipTree(it) } }) {
        include(keptLibs.map { "jni/arm64-v8a/$it" })
        eachFile { path = "arm64-v8a/$name" }
    }
    includeEmptyDirs = false
    into(qnnLibs)
}

val unpackQnnLicenses by tasks.registering(Sync::class) {
    from(qnnRuntime.elements.map { files -> files.map { zipTree(it) } }) {
        include("LICENSE.pdf", "NOTICE.txt")
        eachFile { path = "licenses/qnn-runtime-$name" }
    }
    includeEmptyDirs = false
    into(qnnLicenses)
}

android {
    namespace = "io.github.flufy3d.maalow.qnn"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.flufy3d.maalow.qnn"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "$ortVersion-qnn$qnnVersion"
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        // signed like :app (the debug key): the app only loads a plugin signed with its own key
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    sourceSets["main"].jniLibs.srcDir(qnnLibs)
    sourceSets["main"].assets.srcDir(qnnLicenses)

    packaging {
        // extracted to nativeLibraryDir: the app dlopen()s them by path and FastRPC reads the skels from there
        jniLibs.useLegacyPackaging = true
        // prebuilts as shipped (the skels are Hexagon binaries, not for the NDK's strip)
        jniLibs.keepDebugSymbols += "**/*.so"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.named("preBuild") { dependsOn(unpackQnnLibs, unpackQnnLicenses) }

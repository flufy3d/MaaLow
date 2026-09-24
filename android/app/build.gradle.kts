plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val maafw = rootProject.file("third_party/maafw")

android {
    namespace = "io.github.flufy3d.maalow"
    compileSdk = 36
    ndkVersion = "29.0.14206865" // same NDK MaaFramework 5.13.1 was built with

    defaultConfig {
        applicationId = "io.github.flufy3d.maalow"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild {
            cmake { arguments += listOf("-DANDROID_STL=c++_static", "-DMAAFW_DIR=${maafw.invariantSeparatorsPath}") }
        }
    }

    buildTypes {
        debug { isMinifyEnabled = false }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        aidl = true
        buildConfig = true
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets["main"].jniLibs.srcDirs(maafw.resolve("jniLibs"))

    packaging {
        // MaaFramework dlopen()s the bridge by absolute path, so native libs must be extracted to disk.
        jniLibs.useLegacyPackaging = true
        // These prebuilts are already stripped upstream; re-stripping breaks fastdeploy's DT_GNU_HASH.
        jniLibs.keepDebugSymbols += listOf(
            "**/libfastdeploy_ppocr.so", "**/libonnxruntime.so", "**/libopencv_world4.so", "**/libc++_shared.so",
        )
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:6.1")
    implementation("io.ktor:ktor-server-cio:3.6.0")
    implementation("io.ktor:ktor-server-status-pages:3.6.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}

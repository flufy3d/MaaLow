cmake_minimum_required(VERSION 3.22)
project(maalow C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_compile_options(-O2 -Wall -fvisibility=hidden)

# Our libs link libc++ statically and hide it (only C/JNI symbols are exported). libMaaUtils.so carries the
# libc++ that MaaFramework and its control units bind to, so it must come before any libc++_shared.so in
# the load group rooted at our libraries, as in MaaFramework's own MaaPiCli.
add_link_options(-Wl,--exclude-libs,ALL)

# Device bridge loaded by MaaAndroidNativeControlUnit (library_path). Kept thin and free of Maa dependencies:
# screen frames in, input messages out.
add_library(maalow_bridge SHARED bridge.cpp)
target_link_libraries(maalow_bridge android mediandk jnigraphics log)

# JNI wrapper over the MaaFramework C API.
add_library(MaaFramework SHARED IMPORTED)
set_target_properties(MaaFramework PROPERTIES IMPORTED_LOCATION ${MAAFW_DIR}/jniLibs/arm64-v8a/libMaaFramework.so)
add_library(MaaUtils SHARED IMPORTED)
set_target_properties(MaaUtils PROPERTIES IMPORTED_LOCATION ${MAAFW_DIR}/jniLibs/arm64-v8a/libMaaUtils.so)
add_library(maalow_jni SHARED maa_jni.cpp)
target_include_directories(maalow_jni PRIVATE ${MAAFW_DIR}/include)
target_link_libraries(maalow_jni MaaFramework -Wl,--no-as-needed MaaUtils -Wl,--as-needed log)

# QuickJS (quickjs-ng, fetched by scripts/fetch_quickjs.sh) for workspace skills. Plain C, so it brings no libc++;
# its API stays hidden (no BUILDING_QJS_SHARED) and only the JNI entry points are exported. No Maa dependency:
# everything a script can do goes through one host call into Kotlin.
set(QJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/quickjs-ng)
if(NOT EXISTS ${QJS_DIR}/quickjs.c)
    message(FATAL_ERROR "quickjs-ng sources missing: run android/scripts/fetch_quickjs.sh")
endif()
add_library(qjs STATIC ${QJS_DIR}/quickjs.c ${QJS_DIR}/libregexp.c ${QJS_DIR}/libunicode.c ${QJS_DIR}/dtoa.c)
target_compile_definitions(qjs PRIVATE _GNU_SOURCE QUICKJS_NG_BUILD NDEBUG)
target_compile_options(qjs PRIVATE -funsigned-char -w)
target_include_directories(qjs PUBLIC ${QJS_DIR})
add_library(maalow_js SHARED js_jni.cpp)
target_link_libraries(maalow_js qjs log m)

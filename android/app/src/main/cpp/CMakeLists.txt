cmake_minimum_required(VERSION 3.22)
project(maalow CXX)

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

cmake_minimum_required(VERSION 3.13)

# RN 기본 앱 CMake를 확장해 공용 C++ 코어와 C++ TurboModule을 함께 빌드한다.
project(appmodules)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# apps/mobile/android/app/src/main/jni → 저장소 루트
get_filename_component(HOGA_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../.." ABSOLUTE)

add_subdirectory(${HOGA_ROOT}/core ${CMAKE_CURRENT_BINARY_DIR}/hoga_core)

target_sources(${CMAKE_PROJECT_NAME} PRIVATE ${HOGA_ROOT}/bindings/turbomodule/NativeHogaCore.cpp)
target_include_directories(${CMAKE_PROJECT_NAME} PUBLIC ${HOGA_ROOT}/bindings/turbomodule)
target_link_libraries(${CMAKE_PROJECT_NAME} hoga_core)

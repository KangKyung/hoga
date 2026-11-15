cmake_minimum_required(VERSION 3.22)
project(hoga_core LANGUAGES CXX)

# 같은 CMake 프로젝트를 Android(NDK), Node(cmake-js), 단독 테스트에서 함께 쓴다.
# iOS는 CocoaPods가 소스를 직접 컴파일한다(HogaNative.podspec).

add_library(hoga_core STATIC src/core.cpp)
target_include_directories(hoga_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(hoga_core PUBLIC cxx_std_20)
set_target_properties(hoga_core PROPERTIES POSITION_INDEPENDENT_CODE ON)

if(MSVC)
  target_compile_options(hoga_core PRIVATE /W4)
else()
  target_compile_options(hoga_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

# 단독 빌드일 때만 테스트를 붙인다(앱·Node 빌드에 포함될 때는 제외).
option(HOGA_BUILD_TESTS "Build hoga_core unit tests" ${PROJECT_IS_TOP_LEVEL})

if(HOGA_BUILD_TESTS)
  include(FetchContent)
  FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.tar.gz)
  FetchContent_MakeAvailable(googletest)

  enable_testing()
  add_executable(hoga_core_tests tests/core_test.cpp)
  target_link_libraries(hoga_core_tests PRIVATE hoga_core GTest::gtest_main)
  include(GoogleTest)
  gtest_discover_tests(hoga_core_tests)
endif()

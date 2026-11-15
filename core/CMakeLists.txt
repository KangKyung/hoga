cmake_minimum_required(VERSION 3.22)
project(hoga_core LANGUAGES CXX)

# 같은 CMake 프로젝트를 Android(NDK), Node(cmake-js), 단독 테스트에서 함께 쓴다.
# iOS는 CocoaPods가 소스를 직접 컴파일한다(HogaNative.podspec).

add_library(hoga_core STATIC
  src/core.cpp
  src/order_book.cpp
  src/book_sync.cpp
  src/order.cpp
  src/matching_engine.cpp
  src/market_client.cpp)
target_include_directories(hoga_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
# nlohmann/json(MIT, v3.12.0)은 시세 메시지 파싱에만 쓰므로 공개 헤더에 노출하지 않는다.
target_include_directories(hoga_core SYSTEM PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party)
target_compile_features(hoga_core PUBLIC cxx_std_20)
set_target_properties(hoga_core PROPERTIES POSITION_INDEPENDENT_CODE ON)

if(MSVC)
  target_compile_options(hoga_core PRIVATE /W4)
else()
  target_compile_options(hoga_core PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow)
endif()

# 단독 빌드일 때만 테스트를 붙인다(앱·Node 빌드에 포함될 때는 제외).
option(HOGA_BUILD_TESTS "Build hoga_core unit tests" ${PROJECT_IS_TOP_LEVEL})
# address | thread | undefined (테스트 빌드 전용)
set(HOGA_SANITIZE "" CACHE STRING "Sanitizer to enable for tests: address, thread, undefined")

if(HOGA_SANITIZE)
  set(_san_flags -fsanitize=${HOGA_SANITIZE} -fno-omit-frame-pointer)
  if(HOGA_SANITIZE STREQUAL "address")
    list(APPEND _san_flags -fsanitize=undefined)
  endif()
  target_compile_options(hoga_core PUBLIC ${_san_flags})
  target_link_options(hoga_core PUBLIC ${_san_flags})
endif()

if(HOGA_BUILD_TESTS)
  include(FetchContent)
  FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.tar.gz)
  FetchContent_MakeAvailable(googletest)

  enable_testing()
  add_executable(hoga_core_tests
    tests/core_test.cpp
    tests/order_book_test.cpp
    tests/book_sync_test.cpp
    tests/order_test.cpp
    tests/matching_engine_test.cpp
    tests/market_client_test.cpp)
  target_link_libraries(hoga_core_tests PRIVATE hoga_core GTest::gtest_main)
  include(GoogleTest)
  gtest_discover_tests(hoga_core_tests)
endif()

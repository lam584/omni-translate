cmake_minimum_required(VERSION 3.24)
project(omni_webrtc_aec3_ffi LANGUAGES CXX)

include(CTest)

find_package(unofficial-webrtc CONFIG REQUIRED)

add_library(omni_webrtc_aec3_ffi STATIC omni_webrtc_aec3.cc)
target_compile_features(omni_webrtc_aec3_ffi PRIVATE cxx_std_20)
target_link_libraries(omni_webrtc_aec3_ffi PRIVATE unofficial::webrtc::webrtc)
set_target_properties(omni_webrtc_aec3_ffi PROPERTIES
  CXX_EXTENSIONS OFF
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL"
)

if(BUILD_TESTING)
  add_executable(omni_webrtc_aec3_fixture omni_webrtc_aec3_fixture.cc)
  target_compile_features(omni_webrtc_aec3_fixture PRIVATE cxx_std_20)
  target_link_libraries(omni_webrtc_aec3_fixture PRIVATE omni_webrtc_aec3_ffi)
  set_target_properties(omni_webrtc_aec3_fixture PROPERTIES
    CXX_EXTENSIONS OFF
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL"
  )
  add_test(NAME omni_webrtc_aec3_pure_echo_fixture
           COMMAND omni_webrtc_aec3_fixture)
endif()

install(TARGETS omni_webrtc_aec3_ffi ARCHIVE DESTINATION lib)

cmake_minimum_required(VERSION 3.18)

# enable colors for ninja
set(CMAKE_COLOR_DIAGNOSTICS ON)

project(libretro_wasm_native
  DESCRIPTION "Run libretro cores in wasm"
  HOMEPAGE_URL "https://github.com/konsumer/libretro-wasm"
  VERSION 0.0.1
  LANGUAGES C
)

if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)
  set(CMAKE_POLICY_DEFAULT_CMP0135 NEW)
endif()

if(POLICY CMP0077)
  cmake_policy(SET CMP0077 NEW)
  set(CMAKE_POLICY_DEFAULT_CMP0077 NEW)
endif()

if(POLICY CMP0169)
  cmake_policy(SET CMP0169 NEW)
  set(CMAKE_POLICY_DEFAULT_CMP0169 NEW)
endif()

include(FetchContent)

if(WIN32)
  add_compile_definitions(
    WINAPI_FAMILY=WINAPI_FAMILY_DESKTOP_APP
    WINAPI_PARTITION_APP=0
    WINAPI_PARTITION_DESKTOP=1
  )
endif()

FetchContent_Declare(
    raylib
    URL https://github.com/raysan5/raylib/archive/refs/tags/5.5.zip
)
FetchContent_MakeAvailable(raylib)

string(TOLOWER ${CMAKE_HOST_SYSTEM_NAME} WAMR_BUILD_PLATFORM)
set (WAMR_BUILD_INTERP 1)
set (WAMR_BUILD_DEBUG_INTERP 0)
set (WAMR_BUILD_FAST_INTERP 1)
set (WAMR_BUILD_AOT 0)
set (WAMR_BUILD_LIBC_BUILTIN 0)
set (WAMR_BUILD_LIBC_WASI 1)
if(NOT DEFINED WAMR_BUILD_SIMD)
  set (WAMR_BUILD_SIMD 1)
endif()
set (WAMR_BUILD_REF_TYPES 1)

FetchContent_Declare(wamr
  URL https://github.com/bytecodealliance/wasm-micro-runtime/archive/refs/heads/master.zip
)
FetchContent_MakeAvailable(wamr)

include (${wamr_SOURCE_DIR}/build-scripts/runtime_lib.cmake)

add_executable(libretro_wasm libretro_wasm.c)
target_link_libraries(libretro_wasm PRIVATE vmlib raylib)
target_include_directories(libretro_wasm PRIVATE
  ${wamr_SOURCE_DIR}/core/iwasm/include
  ${wamr_SOURCE_DIR}/core/shared/utils
  ${wamr_SOURCE_DIR}/core/shared/platform/common
)

if(WIN32)
  target_compile_definitions(vmlib PRIVATE NOMINMAX)
  target_compile_definitions(libretro_wasm PRIVATE NOMINMAX)
endif()

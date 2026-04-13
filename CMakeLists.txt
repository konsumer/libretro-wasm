cmake_minimum_required(VERSION 3.18)

option(LIBRETRO_USE_WASI_SDK "Automatically configure the WASI SDK toolchain" ON)

if(LIBRETRO_USE_WASI_SDK AND NOT DEFINED CMAKE_TOOLCHAIN_FILE)
  if(NOT DEFINED WASI_SDK_PREFIX)
    if(DEFINED ENV{WASI_SDK_PREFIX})
      set(WASI_SDK_PREFIX "$ENV{WASI_SDK_PREFIX}")
    else()
      set(WASI_SDK_PREFIX /opt/wasi-sdk)
    endif()
  endif()

  set(_libretro_default_toolchain "${WASI_SDK_PREFIX}/share/cmake/wasi-sdk.cmake")
  if(EXISTS "${_libretro_default_toolchain}")
    set(CMAKE_TOOLCHAIN_FILE "${_libretro_default_toolchain}" CACHE FILEPATH "Toolchain file for WASI builds")
  else()
    message(WARNING "WASI SDK toolchain file not found at ${_libretro_default_toolchain}. Either install wasi-sdk there, set WASI_SDK_PREFIX, or pass -DCMAKE_TOOLCHAIN_FILE explicitly.")
  endif()
endif()

project(libretro_wasm
  DESCRIPTION "Run libretro cores in wasm"
  HOMEPAGE_URL "https://github.com/konsumer/libretro-wasm"
  VERSION 0.0.1
  LANGUAGES C
)

# enable colors for ninja
set(CMAKE_COLOR_DIAGNOSTICS ON)

include(FetchContent)


add_subdirectory(cores)

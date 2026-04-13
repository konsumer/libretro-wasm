cmake_minimum_required(VERSION 3.18)

# enable colors for ninja
set(CMAKE_COLOR_DIAGNOSTICS ON)

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

project(libretro_wasm_cores
  DESCRIPTION "Run libretro cores in wasm"
  HOMEPAGE_URL "https://github.com/konsumer/libretro-wasm"
  VERSION 0.0.1
  LANGUAGES C
)

if(POLICY CMP0169)
  cmake_policy(SET CMP0169 OLD)
endif()

if(NOT CMAKE_SYSTEM_NAME STREQUAL "WASI")
  message(WARNING "cores/ targets the WASI runtime; current toolchain reports '${CMAKE_SYSTEM_NAME}'. Ensure wasi-sdk is configured if the build fails.")
endif()

enable_language(CXX)

add_compile_options(-mno-reference-types)
add_link_options(-mno-reference-types)

# Common link/export flags shared by all WASM cores.
set(_libretro_exports
  __wasm_call_ctors
  retro_init
  retro_deinit
  retro_api_version
  retro_get_system_info
  retro_get_system_av_info
  retro_run
  retro_reset
  retro_set_environment
  retro_set_video_refresh
  retro_set_audio_sample
  retro_set_audio_sample_batch
  retro_set_input_poll
  retro_set_input_state
  retro_load_game
  retro_load_game_special
  retro_unload_game
  retro_set_controller_port_device
  retro_get_region
  retro_get_memory_data
  retro_get_memory_size
  retro_serialize_size
  retro_serialize
  retro_unserialize
  retro_cheat_reset
  retro_cheat_set
  libretro_host_init
)

set(_libretro_link_options
  -Wl,--no-entry
  -Wl,--allow-undefined
  -Wl,--initial-memory=1310720
)

foreach(symbol IN LISTS _libretro_exports)
  list(APPEND _libretro_link_options "-Wl,--export=${symbol}")
endforeach()

function(configure_libretro_wasm_target target_name output_name)
  target_link_options(${target_name} PRIVATE ${_libretro_link_options})
  set_target_properties(${target_name} PROPERTIES
    OUTPUT_NAME ${output_name}
    SUFFIX ".wasm"
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/cores
    LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/cores
  )
endfunction()

# -----------------------------------------------------------------------------
# Fetch dependencies (QuickNES core sources + libretro-common headers)
# -----------------------------------------------------------------------------
include(FetchContent)

FetchContent_Declare(
  quicknes
  URL https://github.com/libretro/QuickNES_Core/archive/refs/heads/master.zip
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)

FetchContent_Declare(
  libretro_common
  URL https://github.com/libretro/libretro-common/archive/refs/heads/master.zip
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)

FetchContent_GetProperties(quicknes)
if(NOT quicknes_POPULATED)
  FetchContent_Populate(quicknes)
endif()

FetchContent_GetProperties(libretro_common)
if(NOT libretro_common_POPULATED)
  FetchContent_Populate(libretro_common)
endif()

set(LIBRETRO_COMMON_INCLUDE_DIR ${libretro_common_SOURCE_DIR}/include)

# Shared shim source compiled into every core target.
set(LIBRETRO_SHIM_SOURCE ${CMAKE_CURRENT_LIST_DIR}/libretro_shim.c)

# -----------------------------------------------------------------------------
# minicore (reference core written in-tree)
# -----------------------------------------------------------------------------
add_executable(minicore minicore.c ${LIBRETRO_SHIM_SOURCE})
target_include_directories(minicore PRIVATE ${LIBRETRO_COMMON_INCLUDE_DIR})
configure_libretro_wasm_target(minicore minicore)

# -----------------------------------------------------------------------------
# QuickNES core using upstream sources through FetchContent
# -----------------------------------------------------------------------------
set(QUICKNES_SOURCES
  ${quicknes_SOURCE_DIR}/libretro/libretro.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/abstract_file.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/apu_state.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Blip_Buffer.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Effects_Buffer.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Multi_Buffer.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Apu.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Buffer.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Cart.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Core.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Cpu.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/nes_data.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Effects_Buffer.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Emu.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_File.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Fme7_Apu.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Mapper.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Vrc7.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/emu2413.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/emu2413_state.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Namco_Apu.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Oscs.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Ppu.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Ppu_Impl.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Ppu_Rendering.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_State.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/nes_util.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Nes_Vrc6_Apu.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/Data_Reader.cpp
  ${quicknes_SOURCE_DIR}/nes_emu/nes_ntsc.cpp
)

add_executable(quicknes_core ${QUICKNES_SOURCES} ${LIBRETRO_SHIM_SOURCE})
target_compile_features(quicknes_core PRIVATE cxx_std_14)
target_include_directories(quicknes_core PRIVATE
  ${quicknes_SOURCE_DIR}
  ${quicknes_SOURCE_DIR}/nes_emu
  ${quicknes_SOURCE_DIR}/libretro
  ${LIBRETRO_COMMON_INCLUDE_DIR}
)
target_compile_definitions(quicknes_core PRIVATE
  __LIBRETRO__
  HAVE_STDINT_H
  HAVE_INTTYPES_H
  HAVE_NO_LANGEXTRA
  NDEBUG
)
target_compile_options(quicknes_core PRIVATE -fno-exceptions -fno-rtti)
target_link_libraries(quicknes_core PRIVATE m)
configure_libretro_wasm_target(quicknes_core quicknes)

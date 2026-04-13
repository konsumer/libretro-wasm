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
FetchContent_MakeAvailable(quicknes)

FetchContent_Declare(
  libretro_common
  URL https://github.com/libretro/libretro-common/archive/refs/heads/master.zip
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(libretro_common)

FetchContent_Declare(
  gambatte
  URL https://github.com/libretro/gambatte-libretro/archive/refs/heads/master.zip
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(gambatte)

FetchContent_Declare(
  stella2014
  URL https://github.com/libretro/stella2014-libretro/archive/refs/heads/master.zip
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(stella2014)

FetchContent_Declare(
  beetle_pce_fast
  URL https://github.com/libretro/beetle-pce-fast-libretro/archive/refs/heads/master.zip
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(beetle_pce_fast)

set(LIBRETRO_COMMON_INCLUDE_DIR ${libretro_common_SOURCE_DIR}/include)
set(LIBRETRO_COMMON_UTILITY_SOURCES
  ${libretro_common_SOURCE_DIR}/compat/compat_posix_string.c
  ${libretro_common_SOURCE_DIR}/compat/compat_snprintf.c
  ${libretro_common_SOURCE_DIR}/compat/compat_strcasestr.c
  ${libretro_common_SOURCE_DIR}/compat/compat_strl.c
  ${libretro_common_SOURCE_DIR}/compat/fopen_utf8.c
  ${libretro_common_SOURCE_DIR}/encodings/encoding_utf.c
  ${libretro_common_SOURCE_DIR}/encodings/encoding_crc32.c
  ${libretro_common_SOURCE_DIR}/file/file_path.c
  ${libretro_common_SOURCE_DIR}/file/file_path_io.c
  ${libretro_common_SOURCE_DIR}/file/retro_dirent.c
  ${libretro_common_SOURCE_DIR}/lists/dir_list.c
  ${libretro_common_SOURCE_DIR}/lists/string_list.c
  ${libretro_common_SOURCE_DIR}/memmap/memalign.c
  ${libretro_common_SOURCE_DIR}/streams/file_stream.c
  ${libretro_common_SOURCE_DIR}/streams/file_stream_transforms.c
  ${libretro_common_SOURCE_DIR}/string/stdstring.c
  ${libretro_common_SOURCE_DIR}/time/rtime.c
  ${libretro_common_SOURCE_DIR}/vfs/vfs_implementation.c
)

# Shared shim/support sources compiled into every core target.
set(LIBRETRO_SHIM_SOURCE
  ${CMAKE_CURRENT_LIST_DIR}/libretro_shim.c
  ${CMAKE_CURRENT_LIST_DIR}/libretro_noexcept.c
)

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

# -----------------------------------------------------------------------------
# Gambatte (Game Boy / Game Boy Color)
# -----------------------------------------------------------------------------
set(GAMBATTE_CORE_DIR ${gambatte_SOURCE_DIR}/libgambatte/src)
set(GAMBATTE_LIBRETRO_DIR ${gambatte_SOURCE_DIR}/libgambatte/libretro)

set(GAMBATTE_SOURCES
  ${GAMBATTE_CORE_DIR}/bootloader.cpp
  ${GAMBATTE_CORE_DIR}/cpu.cpp
  ${GAMBATTE_CORE_DIR}/gambatte.cpp
  ${GAMBATTE_CORE_DIR}/initstate.cpp
  ${GAMBATTE_CORE_DIR}/interrupter.cpp
  ${GAMBATTE_CORE_DIR}/interruptrequester.cpp
  ${GAMBATTE_CORE_DIR}/gambatte-memory.cpp
  ${GAMBATTE_CORE_DIR}/sound.cpp
  ${GAMBATTE_CORE_DIR}/statesaver.cpp
  ${GAMBATTE_CORE_DIR}/tima.cpp
  ${GAMBATTE_CORE_DIR}/video.cpp
  ${GAMBATTE_CORE_DIR}/video_libretro.cpp
  ${GAMBATTE_CORE_DIR}/mem/cartridge.cpp
  ${GAMBATTE_CORE_DIR}/mem/cartridge_libretro.cpp
  ${GAMBATTE_CORE_DIR}/mem/huc3.cpp
  ${GAMBATTE_CORE_DIR}/mem/memptrs.cpp
  ${GAMBATTE_CORE_DIR}/mem/rtc.cpp
  ${GAMBATTE_CORE_DIR}/sound/channel1.cpp
  ${GAMBATTE_CORE_DIR}/sound/channel2.cpp
  ${GAMBATTE_CORE_DIR}/sound/channel3.cpp
  ${GAMBATTE_CORE_DIR}/sound/channel4.cpp
  ${GAMBATTE_CORE_DIR}/sound/duty_unit.cpp
  ${GAMBATTE_CORE_DIR}/sound/envelope_unit.cpp
  ${GAMBATTE_CORE_DIR}/sound/length_counter.cpp
  ${GAMBATTE_CORE_DIR}/video/ly_counter.cpp
  ${GAMBATTE_CORE_DIR}/video/lyc_irq.cpp
  ${GAMBATTE_CORE_DIR}/video/next_m0_time.cpp
  ${GAMBATTE_CORE_DIR}/video/ppu.cpp
  ${GAMBATTE_CORE_DIR}/video/sprite_mapper.cpp
  ${GAMBATTE_LIBRETRO_DIR}/libretro.cpp
  ${GAMBATTE_LIBRETRO_DIR}/gambatte_log.c
  ${GAMBATTE_LIBRETRO_DIR}/blipper.c
  ${LIBRETRO_COMMON_UTILITY_SOURCES}
)

add_executable(gambatte_core ${GAMBATTE_SOURCES} ${LIBRETRO_SHIM_SOURCE})
target_compile_features(gambatte_core PRIVATE cxx_std_14)
target_include_directories(gambatte_core PRIVATE
  ${GAMBATTE_CORE_DIR}
  ${gambatte_SOURCE_DIR}/libgambatte/include
  ${gambatte_SOURCE_DIR}/libgambatte
  ${gambatte_SOURCE_DIR}/common
  ${gambatte_SOURCE_DIR}/common/resample
  ${GAMBATTE_LIBRETRO_DIR}
  ${LIBRETRO_COMMON_INCLUDE_DIR}
)
target_compile_definitions(gambatte_core PRIVATE
  __LIBRETRO__
  HAVE_STDINT_H
  HAVE_INTTYPES_H
  CC_RESAMPLER_NO_HIGHPASS
  VIDEO_RGB565
)
target_compile_options(gambatte_core PRIVATE -fno-exceptions -fno-rtti)
target_link_libraries(gambatte_core PRIVATE m)
configure_libretro_wasm_target(gambatte_core gambatte)

# -----------------------------------------------------------------------------
# Stella 2014 (Atari 2600)
# -----------------------------------------------------------------------------
set(STELLA2014_CORE_DIR ${stella2014_SOURCE_DIR}/stella)

set(STELLA2014_SOURCES
  ${STELLA2014_CORE_DIR}/src/common/Base.cxx
  ${STELLA2014_CORE_DIR}/src/common/Sound.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/AtariVox.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Booster.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Cart.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Cart0840.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Cart2K.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Cart3E.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Cart3F.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Cart4A50.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Cart4K.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Cart4KSC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartAR.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartBF.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartBFSC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartCM.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartCTY.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartCV.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartDF.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartDFSC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartDPC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartDPCPlus.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartE0.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartE7.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartEF.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartEFSC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartF0.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartF4.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartF4SC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartF6.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartF6SC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartF8.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartF8SC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartFA.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartFA2.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartFE.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartMC.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartSB.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartUA.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CartX07.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/CompuMate.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Console.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Control.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Driving.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Genesis.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Joystick.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Keyboard.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/KidVid.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/M6502.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/M6532.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/MD5.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/MindLink.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/MT24LC256.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/NullDev.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Paddles.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Props.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/PropsSet.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Random.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/SaveKey.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Serializer.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Settings.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/StateManager.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Switches.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/System.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/Thumbulator.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/TIA.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/TIASnd.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/TIATables.cxx
  ${STELLA2014_CORE_DIR}/src/emucore/TrackBall.cxx
  ${stella2014_SOURCE_DIR}/libretro.cxx
  ${LIBRETRO_COMMON_UTILITY_SOURCES}
)

add_executable(stella2014_core ${STELLA2014_SOURCES} ${LIBRETRO_SHIM_SOURCE})
target_compile_features(stella2014_core PRIVATE cxx_std_17)
target_include_directories(stella2014_core PRIVATE
  ${STELLA2014_CORE_DIR}
  ${STELLA2014_CORE_DIR}/src
  ${STELLA2014_CORE_DIR}/src/common
  ${STELLA2014_CORE_DIR}/src/emucore
  ${STELLA2014_CORE_DIR}/src/gui
  ${STELLA2014_CORE_DIR}/stubs
  ${LIBRETRO_COMMON_INCLUDE_DIR}
)
target_compile_definitions(stella2014_core PRIVATE
  __LIBRETRO__
  THUMB_SUPPORT
  HAVE_STDINT_H
  HAVE_INTTYPES_H
)
target_compile_options(stella2014_core PRIVATE -fno-exceptions -fno-rtti)
target_link_libraries(stella2014_core PRIVATE m)
configure_libretro_wasm_target(stella2014_core stella2014)

# -----------------------------------------------------------------------------
# Beetle PCE Fast (PC Engine / TurboGrafx-16)
# -----------------------------------------------------------------------------
set(BEETLE_PCE_FAST_DIR ${beetle_pce_fast_SOURCE_DIR})
set(BEETLE_PCE_FAST_MEDNAFEN_DIR ${BEETLE_PCE_FAST_DIR}/mednafen)
set(BEETLE_PCE_FAST_DEPS_DIR ${BEETLE_PCE_FAST_DIR}/deps)

file(GLOB BEETLE_PCE_FAST_PCE_FAST_SOURCES
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/pce_fast/*.c
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/pce_fast/*.cpp
)
file(GLOB BEETLE_PCE_FAST_CDROM_SOURCES
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/cdrom/*.cpp
)
list(FILTER BEETLE_PCE_FAST_CDROM_SOURCES EXCLUDE REGEX "CDAFReader_MPC\.cpp$")
file(GLOB BEETLE_PCE_FAST_MISC_CPP
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/general.cpp
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/FileStream.cpp
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/MemoryStream.cpp
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/Stream.cpp
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/mempatcher.cpp
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/okiadpcm.cpp
)
set(BEETLE_PCE_FAST_MISC_C
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/file.c
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/settings.c
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/state.c
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/mednafen-endian.c
)
file(GLOB BEETLE_PCE_FAST_SOUND_SOURCES
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/sound/*.c
)
file(GLOB BEETLE_PCE_FAST_TREMOR_SOURCES
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/tremor/*.c
)
file(GLOB BEETLE_PCE_FAST_HWMISC_SOURCES
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/hw_misc/arcade_card/*.cpp
)
file(GLOB BEETLE_PCE_FAST_DEPS_CHDR_SOURCES
  ${BEETLE_PCE_FAST_DEPS_DIR}/libchdr/src/*.c
)
file(GLOB BEETLE_PCE_FAST_DEPS_LZMA_SOURCES
  ${BEETLE_PCE_FAST_DEPS_DIR}/lzma-19.00/src/*.c
)
file(GLOB BEETLE_PCE_FAST_DEPS_ZLIB_SOURCES
  ${BEETLE_PCE_FAST_DEPS_DIR}/zlib-1.2.11/*.c
)
file(GLOB BEETLE_PCE_FAST_DEPS_ZSTD_COMMON
  ${BEETLE_PCE_FAST_DEPS_DIR}/zstd/lib/common/*.c
)
file(GLOB BEETLE_PCE_FAST_DEPS_ZSTD_DECOMPRESS
  ${BEETLE_PCE_FAST_DEPS_DIR}/zstd/lib/decompress/*.c
)

set(BEETLE_PCE_FAST_SOURCES
  ${BEETLE_PCE_FAST_DIR}/libretro.cpp
  ${BEETLE_PCE_FAST_PCE_FAST_SOURCES}
  ${BEETLE_PCE_FAST_CDROM_SOURCES}
  ${BEETLE_PCE_FAST_MISC_CPP}
  ${BEETLE_PCE_FAST_MISC_C}
  ${BEETLE_PCE_FAST_SOUND_SOURCES}
  ${BEETLE_PCE_FAST_TREMOR_SOURCES}
  ${BEETLE_PCE_FAST_HWMISC_SOURCES}
  ${BEETLE_PCE_FAST_DEPS_CHDR_SOURCES}
  ${BEETLE_PCE_FAST_DEPS_LZMA_SOURCES}
  ${BEETLE_PCE_FAST_DEPS_ZLIB_SOURCES}
  ${BEETLE_PCE_FAST_DEPS_ZSTD_COMMON}
  ${BEETLE_PCE_FAST_DEPS_ZSTD_DECOMPRESS}
  ${LIBRETRO_COMMON_UTILITY_SOURCES}
  ${LIBRETRO_SHIM_SOURCE}
)

add_executable(beetle_pce_fast_core ${BEETLE_PCE_FAST_SOURCES})
target_compile_features(beetle_pce_fast_core PRIVATE cxx_std_17)
target_include_directories(beetle_pce_fast_core PRIVATE
  ${BEETLE_PCE_FAST_DIR}
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/include
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/hw_misc
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/hw_cpu
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/hw_sound
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/sound
  ${BEETLE_PCE_FAST_MEDNAFEN_DIR}/tremor
  ${BEETLE_PCE_FAST_DEPS_DIR}/libchdr/include
  ${BEETLE_PCE_FAST_DEPS_DIR}/lzma-19.00/include
  ${BEETLE_PCE_FAST_DEPS_DIR}/zlib-1.2.11
  ${BEETLE_PCE_FAST_DEPS_DIR}/zstd/lib
  ${LIBRETRO_COMMON_INCLUDE_DIR}
)
target_compile_definitions(beetle_pce_fast_core PRIVATE
  __LIBRETRO__
  HAVE_STDINT_H
  HAVE_INTTYPES_H
  FRONTEND_SUPPORTS_RGB565
  WANT_STEREO_SOUND
  NEED_TREMOR
  NEED_CD
  USE_CHEATS
  _7ZIP_ST
  ZSTD_DISABLE_ASM
  INLINE=inline
  MEDNAFEN_VERSION=\"0.9.26\"
  MEDNAFEN_VERSION_NUMERIC=926
)
target_compile_options(beetle_pce_fast_core PRIVATE -fno-rtti)
target_link_libraries(beetle_pce_fast_core PRIVATE m c++ c++abi)
configure_libretro_wasm_target(beetle_pce_fast_core beetle_pce_fast)
target_link_options(beetle_pce_fast_core PRIVATE -Wl,--initial-memory=6291456)

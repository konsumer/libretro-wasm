WASI_SDK_PATH ?= /opt/wasi-sdk
WASI_SYSROOT ?= $(WASI_SDK_PATH)/share/wasi-sysroot

CC := $(WASI_SDK_PATH)/bin/clang
CXX := $(WASI_SDK_PATH)/bin/clang++

CORE_SRC := core/minicore.c
CORE_OUT := src/cores/minicore.wasm

WASI_TARGET_FLAGS := --target=wasm32-wasip1 --sysroot=$(WASI_SYSROOT)

CFLAGS ?= -O2
CFLAGS += $(WASI_TARGET_FLAGS) -I.

CXXFLAGS ?= -O2
CXXFLAGS += $(WASI_TARGET_FLAGS) -I. -std=gnu++14

LDFLAGS += $(WASI_TARGET_FLAGS) \
  -Wl,--no-entry -Wl,--import-table -Wl,--allow-undefined -Wl,--growable-table

EXPORTED_FUNCS := __wasm_call_ctors retro_init retro_deinit retro_api_version \
  retro_get_system_info retro_get_system_av_info retro_run retro_reset \
  retro_set_environment retro_set_video_refresh retro_set_audio_sample \
  retro_set_audio_sample_batch retro_set_input_poll retro_set_input_state \
  retro_load_game retro_load_game_special retro_unload_game \
  retro_set_controller_port_device retro_get_region retro_get_memory_data \
  retro_get_memory_size retro_serialize_size retro_serialize \
  retro_unserialize retro_cheat_reset retro_cheat_set

EXPORT_FLAGS := $(foreach fn,$(EXPORTED_FUNCS),-Wl,--export=$(fn))

QUICKNES_DIR := third_party/quicknes
QUICKNES_BUILD_DIR := build/quicknes

ifeq ($(wildcard $(QUICKNES_DIR)/Makefile.common),)
QUICKNES_SOURCES :=
QUICKNES_INCFLAGS :=
else
override CORE_DIR := $(QUICKNES_DIR)
include $(QUICKNES_DIR)/Makefile.common
QUICKNES_SOURCES := $(SOURCES_CXX)
QUICKNES_INCFLAGS := $(INCFLAGS)
SOURCES_CXX :=
INCFLAGS :=
override CORE_DIR := core
endif

QUICKNES_OBJS := $(patsubst $(QUICKNES_DIR)/%.cpp,$(QUICKNES_BUILD_DIR)/%.o,$(QUICKNES_SOURCES))
QUICKNES_OUT := src/cores/quicknes.wasm
QUICKNES_DEFINES := -D__LIBRETRO__ -DHAVE_STDINT_H -DHAVE_INTTYPES_H -DHAVE_NO_LANGEXTRA -DNDEBUG

ALL_CORES := $(CORE_OUT)
ifneq ($(QUICKNES_SOURCES),)
ALL_CORES += $(QUICKNES_OUT)
endif

.PHONY: all clean

all: $(ALL_CORES)

src/cores:
	mkdir -p src/cores

$(CORE_OUT): $(CORE_SRC) core/libretro.h | src/cores
	$(CC) $(CFLAGS) $< -o $@ $(LDFLAGS) $(EXPORT_FLAGS)

$(QUICKNES_OUT): $(QUICKNES_OBJS) | src/cores
	$(CXX) $(CXXFLAGS) $^ -o $@ $(LDFLAGS) $(EXPORT_FLAGS)

$(QUICKNES_BUILD_DIR)/%.o: $(QUICKNES_DIR)/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(QUICKNES_DEFINES) $(QUICKNES_INCFLAGS) -c $< -o $@

clean:
	rm -rf build src/cores

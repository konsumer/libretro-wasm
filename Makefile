WASI_SDK_PATH ?= /opt/wasi-sdk
WASI_SYSROOT ?= $(WASI_SDK_PATH)/share/wasi-sysroot

CC := $(WASI_SDK_PATH)/bin/clang

CORE_SRC := core/minicore.c
CORE_OUT := dist/minicore.wasm

CFLAGS ?= -O2
CFLAGS += --target=wasm32-wasi --sysroot=$(WASI_SYSROOT) -I.

LDFLAGS += --target=wasm32-wasi --sysroot=$(WASI_SYSROOT) \
  -Wl,--no-entry -Wl,--export-table -Wl,--allow-undefined

EXPORTED_FUNCS := retro_init retro_deinit retro_api_version \
  retro_get_system_info retro_get_system_av_info retro_run retro_reset \
  retro_set_environment retro_set_video_refresh retro_set_audio_sample \
  retro_set_audio_sample_batch retro_set_input_poll retro_set_input_state \
  retro_load_game retro_load_game_special retro_unload_game \
  retro_set_controller_port_device retro_get_region retro_get_memory_data \
  retro_get_memory_size retro_serialize_size retro_serialize \
  retro_unserialize retro_cheat_reset retro_cheat_set

EXPORT_FLAGS := $(foreach fn,$(EXPORTED_FUNCS),-Wl,--export=$(fn))

.PHONY: all clean

all: $(CORE_OUT)

dist:
	mkdir -p dist

$(CORE_OUT): $(CORE_SRC) core/libretro.h | dist
	$(CC) $(CFLAGS) $< -o $@ $(LDFLAGS) $(EXPORT_FLAGS)

clean:
	rm -rf dist

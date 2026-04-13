#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#if !defined(RETRO_CALLCONV)
#define RETRO_CALLCONV
#endif

typedef bool (RETRO_CALLCONV *retro_environment_t)(unsigned cmd, void *data);
typedef void (RETRO_CALLCONV *retro_video_refresh_t)(const void *data, unsigned width, unsigned height, size_t pitch);
typedef void (RETRO_CALLCONV *retro_audio_sample_t)(int16_t left, int16_t right);
typedef size_t (RETRO_CALLCONV *retro_audio_sample_batch_t)(const int16_t *data, size_t frames);
typedef void (RETRO_CALLCONV *retro_input_poll_t)(void);
typedef int16_t (RETRO_CALLCONV *retro_input_state_t)(unsigned port, unsigned device, unsigned index, unsigned id);

void retro_set_environment(retro_environment_t cb);
void retro_set_video_refresh(retro_video_refresh_t cb);
void retro_set_audio_sample(retro_audio_sample_t cb);
void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb);
void retro_set_input_poll(retro_input_poll_t cb);
void retro_set_input_state(retro_input_state_t cb);

__attribute__((import_module("libretro_host"), import_name("environment")))
bool libretro_host_environment(unsigned cmd, void *data);

__attribute__((import_module("libretro_host"), import_name("video_refresh")))
void libretro_host_video_refresh(const void *data, unsigned width, unsigned height, size_t pitch);

__attribute__((import_module("libretro_host"), import_name("audio_sample")))
void libretro_host_audio_sample(int16_t left, int16_t right);

__attribute__((import_module("libretro_host"), import_name("audio_sample_batch")))
size_t libretro_host_audio_sample_batch(const int16_t *data, size_t frames);

__attribute__((import_module("libretro_host"), import_name("input_poll")))
void libretro_host_input_poll(void);

__attribute__((import_module("libretro_host"), import_name("input_state")))
int16_t libretro_host_input_state(unsigned port, unsigned device, unsigned index, unsigned id);

static bool RETRO_CALLCONV shim_environment(unsigned cmd, void *data)
{
    return libretro_host_environment(cmd, data);
}

static void RETRO_CALLCONV shim_video_refresh(const void *data, unsigned width, unsigned height, size_t pitch)
{
    libretro_host_video_refresh(data, width, height, pitch);
}

static void RETRO_CALLCONV shim_audio_sample(int16_t left, int16_t right)
{
    libretro_host_audio_sample(left, right);
}

static size_t RETRO_CALLCONV shim_audio_sample_batch(const int16_t *data, size_t frames)
{
    return libretro_host_audio_sample_batch(data, frames);
}

static void RETRO_CALLCONV shim_input_poll(void)
{
    libretro_host_input_poll();
}

static int16_t RETRO_CALLCONV shim_input_state(unsigned port, unsigned device, unsigned index, unsigned id)
{
    return libretro_host_input_state(port, device, index, id);
}

void libretro_host_init(void)
{
    static bool callbacks_registered = false;
    if (callbacks_registered)
        return;

    retro_set_environment(shim_environment);
    retro_set_video_refresh(shim_video_refresh);
    retro_set_audio_sample(shim_audio_sample);
    retro_set_audio_sample_batch(shim_audio_sample_batch);
    retro_set_input_poll(shim_input_poll);
    retro_set_input_state(shim_input_state);

    callbacks_registered = true;
}

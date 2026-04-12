#include "libretro.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define MINI_WIDTH 320
#define MINI_HEIGHT 240

static retro_environment_t environment_cb;
static retro_video_refresh_t video_cb;
static retro_audio_sample_t audio_sample_cb;
static retro_audio_sample_batch_t audio_batch_cb;
static retro_input_poll_t input_poll_cb;
static retro_input_state_t input_state_cb;

static uint16_t framebuffer[MINI_WIDTH * MINI_HEIGHT];
static uint8_t save_ram[8 * 1024];
static uint8_t rom_buffer[64 * 1024];
static size_t rom_size;

static uint32_t frame_counter;

void retro_set_environment(retro_environment_t cb)
{
   environment_cb = cb;

   if (environment_cb)
   {
      const bool support_no_game = true;
      environment_cb(RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME, (void *)&support_no_game);
   }
}

void retro_set_video_refresh(retro_video_refresh_t cb)
{
   video_cb = cb;
}

void retro_set_audio_sample(retro_audio_sample_t cb)
{
   audio_sample_cb = cb;
}

void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb)
{
   audio_batch_cb = cb;
}

void retro_set_input_poll(retro_input_poll_t cb)
{
   input_poll_cb = cb;
}

void retro_set_input_state(retro_input_state_t cb)
{
   input_state_cb = cb;
}

void retro_init(void)
{
}

void retro_deinit(void)
{
}

unsigned retro_api_version(void)
{
   return RETRO_API_VERSION;
}

void retro_get_system_info(struct retro_system_info *info)
{
   info->library_name = "MiniCore";
   info->library_version = "0.1";
   info->valid_extensions = "";
   info->need_fullpath = false;
   info->block_extract = false;
}

void retro_get_system_av_info(struct retro_system_av_info *info)
{
   info->geometry.base_width = MINI_WIDTH;
   info->geometry.base_height = MINI_HEIGHT;
   info->geometry.max_width = MINI_WIDTH;
   info->geometry.max_height = MINI_HEIGHT;
   info->geometry.aspect_ratio = (float)MINI_WIDTH / (float)MINI_HEIGHT;

   info->timing.fps = 60.0;
   info->timing.sample_rate = 44100.0;
}

void retro_reset(void)
{
   frame_counter = 0;
}

void retro_run(void)
{
   if (input_poll_cb)
      input_poll_cb();

   const uint16_t color1 = 0x001F; // blue
   const uint16_t color2 = 0x7C00; // red

   for (unsigned y = 0; y < MINI_HEIGHT; y++)
   {
      for (unsigned x = 0; x < MINI_WIDTH; x++)
      {
         uint16_t color = ((x + frame_counter) & 0x20) ? color1 : color2;
         framebuffer[y * MINI_WIDTH + x] = color;
      }
   }

   if (video_cb)
      video_cb(framebuffer, MINI_WIDTH, MINI_HEIGHT, MINI_WIDTH * sizeof(uint16_t));

   if (audio_batch_cb)
   {
      static int16_t samples[2 * 512];
      memset(samples, 0, sizeof(samples));
      audio_batch_cb(samples, 512);
   }
   else if (audio_sample_cb)
   {
      audio_sample_cb(0, 0);
   }

   frame_counter++;
}

bool retro_load_game(const struct retro_game_info *info)
{
   (void)info;
   frame_counter = 0;
   memset(save_ram, 0, sizeof(save_ram));

   if (info && info->data && info->size)
   {
      rom_size = info->size > sizeof(rom_buffer) ? sizeof(rom_buffer) : info->size;
      memcpy(rom_buffer, info->data, rom_size);
   }
   else
   {
      rom_size = 0;
   }
   return true;
}

bool retro_load_game_special(unsigned game_type, const struct retro_game_info *info, size_t num_info)
{
   (void)game_type;
   (void)info;
   (void)num_info;
   return false;
}

void retro_unload_game(void)
{
}

unsigned retro_get_region(void)
{
   return RETRO_REGION_NTSC;
}

void *retro_get_memory_data(unsigned id)
{
   if (id == RETRO_MEMORY_SAVE_RAM)
      return save_ram;
   if (id == RETRO_MEMORY_SYSTEM_RAM)
      return rom_size ? rom_buffer : NULL;
   return NULL;
}

size_t retro_get_memory_size(unsigned id)
{
   if (id == RETRO_MEMORY_SAVE_RAM)
      return sizeof(save_ram);
    if (id == RETRO_MEMORY_SYSTEM_RAM)
      return rom_size;
   return 0;
}

void retro_set_controller_port_device(unsigned port, unsigned device)
{
   (void)port;
   (void)device;
}

size_t retro_serialize_size(void)
{
   return 0;
}

bool retro_serialize(void *data, size_t size)
{
   (void)data;
   (void)size;
   return false;
}

bool retro_unserialize(const void *data, size_t size)
{
   (void)data;
   (void)size;
   return false;
}

void retro_cheat_reset(void)
{
}

void retro_cheat_set(unsigned index, bool enabled, const char *code)
{
   (void)index;
   (void)enabled;
   (void)code;
}

/**
 * Native libretro host powered by raylib + WAMR.
 */

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <direct.h>
#else
#include <unistd.h>
#endif

#include <raylib.h>
#include <wasm_export.h>

#if defined(_WIN32) && !defined(PATH_MAX)
#ifdef _MAX_PATH
#define PATH_MAX _MAX_PATH
#else
#define PATH_MAX 260
#endif
#endif

#define MODULE_STACK_SIZE (1024 * 1024 * 2)
#define MODULE_HEAP_SIZE (1024 * 1024 * 10)
#define RUNTIME_HEAP_SIZE (16 * 1024 * 1024)
#define AUDIO_MIN_CHUNK_FRAMES 256
#define AUDIO_MAX_CHUNK_FRAMES 4096
#define AUDIO_CHUNKS_PER_FRAME 2.0
#define AUDIO_DEVICE_SAMPLE_RATE 48000.0
#define AUDIO_RING_CHUNKS 64
#define AUDIO_RING_MIN_CAPACITY 2048
#define RETRO_HW_FRAME_BUFFER_VALID 0xffffffffu

enum { RETRO_DEVICE_NONE = 0, RETRO_DEVICE_JOYPAD = 1 };
enum {
    RETRO_DEVICE_ID_JOYPAD_B = 0,
    RETRO_DEVICE_ID_JOYPAD_Y = 1,
    RETRO_DEVICE_ID_JOYPAD_SELECT = 2,
    RETRO_DEVICE_ID_JOYPAD_START = 3,
    RETRO_DEVICE_ID_JOYPAD_UP = 4,
    RETRO_DEVICE_ID_JOYPAD_DOWN = 5,
    RETRO_DEVICE_ID_JOYPAD_LEFT = 6,
    RETRO_DEVICE_ID_JOYPAD_RIGHT = 7,
    RETRO_DEVICE_ID_JOYPAD_A = 8,
    RETRO_DEVICE_ID_JOYPAD_X = 9,
    RETRO_DEVICE_ID_JOYPAD_L = 10,
    RETRO_DEVICE_ID_JOYPAD_R = 11,
};

enum {
    RETRO_ENVIRONMENT_SET_ROTATION = 1,
    RETRO_ENVIRONMENT_GET_CAN_DUPE = 3,
    RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO = 32,
    RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9,
    RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10,
    RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS = 11,
    RETRO_ENVIRONMENT_GET_VARIABLE = 15,
    RETRO_ENVIRONMENT_SET_VARIABLES = 16,
    RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE = 17,
    RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18,
    RETRO_ENVIRONMENT_SET_CONTROLLER_INFO = 35,
    RETRO_ENVIRONMENT_SET_MEMORY_MAPS = (1u << 16) | 36u,
    RETRO_ENVIRONMENT_GET_LANGUAGE = 39,
    RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE = (1u << 16) | 47u,
    RETRO_ENVIRONMENT_GET_INPUT_BITMASKS = (1u << 16) | 51u,
    RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION = 52,
    RETRO_ENVIRONMENT_SET_CORE_OPTIONS = 53,
    RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL = 54,
    RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY = 55,
    RETRO_ENVIRONMENT_SET_MESSAGE = 6,
    RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION = 59,
    RETRO_ENVIRONMENT_SET_MESSAGE_EXT = 60,
    RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27,
    RETRO_ENVIRONMENT_SET_VARIABLE = 70,
};

enum { RETRO_PIXEL_FORMAT_RGB565 = 2 };

typedef struct {
    uint32_t path;
    uint32_t data;
    uint32_t size;
    uint32_t meta;
} retro_game_info_wasm;

typedef struct {
    uint32_t library_name;
    uint32_t library_version;
    uint32_t valid_extensions;
    uint8_t need_fullpath;
    uint8_t block_extract;
    uint8_t padding[2];
} retro_system_info_wasm;

struct retro_game_geometry {
    uint32_t base_width;
    uint32_t base_height;
    uint32_t max_width;
    uint32_t max_height;
    float aspect_ratio;
};

struct retro_system_timing {
    double fps;
    double sample_rate;
};

typedef struct {
    struct retro_game_geometry geometry;
    struct retro_system_timing timing;
} retro_system_av_info_host;

typedef struct {
    int16_t *data;
    size_t capacity;
    size_t head;
    size_t size;
} AudioRingBuffer;

typedef struct {
    int16_t *data;
    size_t capacity;
    size_t frames;
} SampleFIFO;

typedef struct {
    wasm_module_t module;
    wasm_module_inst_t module_inst;
    wasm_exec_env_t exec_env;
    wasm_function_inst_t fn_libretro_host_init;
    wasm_function_inst_t fn_retro_init;
    wasm_function_inst_t fn_retro_run;
    wasm_function_inst_t fn_retro_deinit;
    wasm_function_inst_t fn_retro_load_game;
    wasm_function_inst_t fn_retro_unload_game;
    wasm_function_inst_t fn_retro_get_system_info;
    wasm_function_inst_t fn_retro_get_system_av_info;

    uint8_t *core_bytes;
    size_t core_size;
    void *runtime_heap;
    bool runtime_ready;

    uint32_t rom_data_ptr;
    uint32_t rom_path_ptr;
    uint32_t game_info_ptr;
    uint32_t system_dir_ptr;
    bool game_loaded;

    double frame_rate;
    double sample_rate;
    double display_aspect;
    retro_system_av_info_host current_av_info;
    bool av_info_valid;

    Texture2D texture;
    bool texture_ready;
    uint16_t *framebuffer;
    size_t framebuffer_capacity;
    unsigned fb_width;
    unsigned fb_height;
    bool pixel_format_rgb565;

    AudioStream audio_stream;
    bool audio_ready;
    AudioRingBuffer audio_queue;
    int16_t *audio_chunk;
    int audio_chunk_frames;
    int audio_channels;
    bool audio_started;
    double device_sample_rate;
    double source_sample_rate;
    double resample_ratio;
    double resample_pos;
    bool resample_initialized;
    SampleFIFO resample_fifo;

    bool running;
    char window_title[256];
    char host_rom_path[PATH_MAX];
    char guest_rom_path[PATH_MAX];
    char rom_directory[PATH_MAX];
    uint32_t option_ngp_language_ptr;
} HostContext;

static HostContext g_host = {0};

static char g_wasi_map_entries[4][PATH_MAX * 2];
static const char *g_wasi_map_ptrs[4];
static uint32_t g_wasi_map_count = 0;

static bool audio_ring_init(AudioRingBuffer *rb, size_t initial_capacity) {
    rb->data = (int16_t *)malloc(initial_capacity * sizeof(int16_t));
    if (!rb->data) {
        rb->capacity = rb->size = rb->head = 0;
        return false;
    }
    rb->capacity = initial_capacity;
    rb->head = 0;
    rb->size = 0;
    return true;
}

static void audio_ring_free(AudioRingBuffer *rb) {
    free(rb->data);
    rb->data = NULL;
    rb->capacity = 0;
    rb->head = 0;
    rb->size = 0;
}

static size_t audio_ring_size(const AudioRingBuffer *rb) {
    return rb->size;
}

static size_t audio_ring_tail(const AudioRingBuffer *rb) {
    if (rb->capacity == 0) {
        return 0;
    }
    return (rb->head + rb->size) % rb->capacity;
}

static bool audio_ring_reserve(AudioRingBuffer *rb, size_t additional) {
    if (rb->size + additional <= rb->capacity) {
        return true;
    }
    size_t new_capacity = rb->capacity ? rb->capacity : AUDIO_RING_MIN_CAPACITY;
    while (new_capacity < rb->size + additional) {
        new_capacity *= 2;
    }
    int16_t *new_data = (int16_t *)malloc(new_capacity * sizeof(int16_t));
    if (!new_data) {
        return false;
    }
    for (size_t i = 0; i < rb->size; ++i) {
        new_data[i] = rb->data[(rb->head + i) % rb->capacity];
    }
    free(rb->data);
    rb->data = new_data;
    rb->capacity = new_capacity;
    rb->head = 0;
    return true;
}

static bool audio_ring_push(AudioRingBuffer *rb, const int16_t *samples, size_t count) {
    if (count == 0) {
        return true;
    }
    if (!audio_ring_reserve(rb, count)) {
        return false;
    }
    size_t tail = audio_ring_tail(rb);
    for (size_t i = 0; i < count; ++i) {
        rb->data[tail] = samples[i];
        tail = (tail + 1) % rb->capacity;
    }
    rb->size += count;
    return true;
}

static void reset_core_option_cache(void) {
    if (g_host.option_ngp_language_ptr && g_host.module_inst) {
        wasm_runtime_module_free(g_host.module_inst, g_host.option_ngp_language_ptr);
    }
    g_host.option_ngp_language_ptr = 0;
}

static size_t audio_ring_pop(AudioRingBuffer *rb, int16_t *dest, size_t max_count) {
    if (rb->size == 0 || max_count == 0) {
        return 0;
    }
    size_t n = rb->size < max_count ? rb->size : max_count;
    for (size_t i = 0; i < n; ++i) {
        dest[i] = rb->data[rb->head];
        rb->head = (rb->head + 1) % rb->capacity;
    }
    rb->size -= n;
    if (rb->size == 0) {
        rb->head = 0;
    }
    return n;
}

static void sample_fifo_init(SampleFIFO *fifo) {
    fifo->data = NULL;
    fifo->capacity = 0;
    fifo->frames = 0;
}

static void sample_fifo_free(SampleFIFO *fifo) {
    free(fifo->data);
    fifo->data = NULL;
    fifo->capacity = 0;
    fifo->frames = 0;
}

static bool sample_fifo_reserve(SampleFIFO *fifo, size_t frames) {
    if (frames <= fifo->capacity) {
        return true;
    }
    size_t new_capacity = fifo->capacity ? fifo->capacity : 1024;
    while (new_capacity < frames) {
        new_capacity *= 2;
    }
    size_t bytes = new_capacity * 2 * sizeof(int16_t);
    int16_t *new_data = (int16_t *)realloc(fifo->data, bytes);
    if (!new_data) {
        return false;
    }
    fifo->data = new_data;
    fifo->capacity = new_capacity;
    return true;
}

static bool sample_fifo_append(SampleFIFO *fifo, const int16_t *samples, size_t frames) {
    if (frames == 0) {
        return true;
    }
    size_t needed_frames = fifo->frames + frames;
    if (!sample_fifo_reserve(fifo, needed_frames)) {
        return false;
    }
    memcpy(fifo->data + fifo->frames * 2, samples, frames * 2 * sizeof(int16_t));
    fifo->frames = needed_frames;
    return true;
}

static void sample_fifo_consume(SampleFIFO *fifo, size_t frames) {
    if (frames == 0) {
        return;
    }
    if (frames >= fifo->frames) {
        fifo->frames = 0;
        return;
    }
    size_t remaining_frames = fifo->frames - frames;
    memmove(fifo->data, fifo->data + frames * 2, remaining_frames * 2 * sizeof(int16_t));
    fifo->frames = remaining_frames;
}

static void sample_fifo_reset(SampleFIFO *fifo) {
    fifo->frames = 0;
}

static void reset_resampler_state(void) {
    sample_fifo_reset(&g_host.resample_fifo);
    g_host.resample_pos = 0.0;
    g_host.resample_initialized = false;
}

static void free_resampler_state(void) {
    sample_fifo_free(&g_host.resample_fifo);
    g_host.resample_pos = 0.0;
    g_host.resample_initialized = false;
}

static void queue_resampled_audio(const int16_t *samples, size_t frames) {
    if (!samples || frames == 0) {
        return;
    }
    if (!g_host.audio_ready) {
        return;
    }
    if (g_host.audio_channels <= 0) {
        return;
    }
    if (g_host.source_sample_rate <= 0.0) {
        g_host.source_sample_rate = g_host.device_sample_rate > 0.0 ? g_host.device_sample_rate : AUDIO_DEVICE_SAMPLE_RATE;
    }
    if (g_host.device_sample_rate <= 0.0) {
        g_host.device_sample_rate = AUDIO_DEVICE_SAMPLE_RATE;
    }
    if (fabs(g_host.source_sample_rate - g_host.device_sample_rate) < 1.0) {
        if (!audio_ring_push(&g_host.audio_queue, samples, frames * (size_t)g_host.audio_channels)) {
            TraceLog(LOG_WARNING, "Audio queue overflow");
        }
        return;
    }
    if (!sample_fifo_append(&g_host.resample_fifo, samples, frames)) {
        TraceLog(LOG_WARNING, "Unable to buffer resampler input");
        return;
    }
    double ratio = g_host.resample_ratio;
    if (ratio <= 0.0) {
        ratio = g_host.source_sample_rate / g_host.device_sample_rate;
        if (ratio <= 0.0) {
            ratio = 1.0;
        }
        g_host.resample_ratio = ratio;
    }
    double pos = g_host.resample_pos;
    size_t available = g_host.resample_fifo.frames;
    while ((size_t)(pos + 1.0) < available) {
        size_t idx = (size_t)pos;
        double frac = pos - (double)idx;
        int16_t *base = g_host.resample_fifo.data + idx * 2;
        int16_t *next = g_host.resample_fifo.data + (idx + 1) * 2;
        int32_t left = base[0] + (int32_t)((next[0] - base[0]) * frac);
        int32_t right = base[1] + (int32_t)((next[1] - base[1]) * frac);
        int16_t out[2] = { (int16_t)left, (int16_t)right };
        if (!audio_ring_push(&g_host.audio_queue, out, 2)) {
            TraceLog(LOG_WARNING, "Audio queue overflow");
            break;
        }
        g_host.resample_initialized = true;
        pos += ratio;
        available = g_host.resample_fifo.frames;
    }
    size_t consume = (size_t)pos;
    if (consume > 0) {
        sample_fifo_consume(&g_host.resample_fifo, consume);
        pos -= (double)consume;
    }
    g_host.resample_pos = pos;
}

static void service_audio_stream(int max_iterations, bool pad_if_empty) {
    if (!g_host.audio_ready || !g_host.audio_chunk) {
        return;
    }
    size_t chunk_samples = (size_t)g_host.audio_chunk_frames * (size_t)g_host.audio_channels;
    int iterations = 0;
    bool allow_padding = pad_if_empty && !g_host.audio_started;
    while (IsAudioStreamProcessed(g_host.audio_stream) && iterations < max_iterations) {
        size_t available = audio_ring_size(&g_host.audio_queue);
        size_t popped = 0;

        if (available >= chunk_samples) {
            popped = audio_ring_pop(&g_host.audio_queue, g_host.audio_chunk, chunk_samples);
        } else if (allow_padding) {
            if (available > 0) {
                popped = audio_ring_pop(&g_host.audio_queue, g_host.audio_chunk, available);
            }
        } else {
            break;
        }

        if (!popped && !allow_padding) {
            break;
        }

        if (popped < chunk_samples) {
            memset(g_host.audio_chunk + popped, 0, (chunk_samples - popped) * sizeof(int16_t));
        }

        if (popped == chunk_samples) {
            g_host.audio_started = true;
            allow_padding = pad_if_empty && !g_host.audio_started;
        }

        UpdateAudioStream(g_host.audio_stream, g_host.audio_chunk, g_host.audio_chunk_frames);
        iterations += 1;
    }
}

static void destroy_audio_stream(void) {
    if (g_host.audio_ready) {
        StopAudioStream(g_host.audio_stream);
        UnloadAudioStream(g_host.audio_stream);
        CloseAudioDevice();
        g_host.audio_ready = false;
    }
    audio_ring_free(&g_host.audio_queue);
    if (g_host.audio_chunk) {
        free(g_host.audio_chunk);
        g_host.audio_chunk = NULL;
    }
    g_host.audio_chunk_frames = 0;
    g_host.audio_channels = 0;
    g_host.audio_started = false;
    free_resampler_state();
}

static void update_frame_timing(double fps) {
    if (fps <= 0.0) {
        fps = 60.0;
    }
    g_host.frame_rate = fps;
    if (IsWindowReady()) {
        int target = (int)ceil(fps);
        if (target <= 0) {
            target = 60;
        }
        SetTargetFPS(target);
    }
}

static void update_audio_sample_rate(double sample_rate);
static void apply_system_av_info(const retro_system_av_info_host *info);

static const char *path_basename(const char *path) {
    if (!path) {
        return "";
    }
    const char *slash = strrchr(path, '/');
#if defined(_WIN32)
    const char *backslash = strrchr(path, '\\');
    if (!slash || (backslash && backslash > slash)) {
        slash = backslash;
    }
#endif
    return slash ? slash + 1 : path;
}

static bool make_absolute_path(const char *input, char *output, size_t size) {
    if (!input || !output || size == 0) {
        return false;
    }
#if defined(_WIN32)
    return _fullpath(output, input, size) != NULL;
#else
    char *resolved = realpath(input, output);
    return resolved != NULL;
#endif
}

static void path_dirname_copy(const char *path, char *output, size_t size) {
    if (!output || size == 0) {
        return;
    }
    if (!path || !*path) {
        snprintf(output, size, ".");
        return;
    }
    strncpy(output, path, size - 1);
    output[size - 1] = '\0';
    char *slash = strrchr(output, '/');
#if defined(_WIN32)
    char *backslash = strrchr(output, '\\');
    if (!slash || (backslash && backslash > slash)) {
        slash = backslash;
    }
#endif
    if (!slash) {
        snprintf(output, size, ".");
    }
    else if (slash == output) {
        slash[1] = '\0';
    }
    else {
        *slash = '\0';
    }
}

static void wasi_reset_map_entries(void) {
    g_wasi_map_count = 0;
}

static void wasi_add_map_entry(const char *guest, const char *host) {
    if (!guest || !host || g_wasi_map_count >= (sizeof(g_wasi_map_ptrs) / sizeof(g_wasi_map_ptrs[0]))) {
        return;
    }
    snprintf(g_wasi_map_entries[g_wasi_map_count], sizeof(g_wasi_map_entries[g_wasi_map_count]), "%s::%s", guest, host);
    g_wasi_map_ptrs[g_wasi_map_count] = g_wasi_map_entries[g_wasi_map_count];
    g_wasi_map_count += 1;
}

static void configure_wasi_for_rom_dir(const char *rom_dir) {
    wasi_reset_map_entries();
    if (rom_dir && *rom_dir) {
        wasi_add_map_entry("/rom", rom_dir);
    }
    wasm_runtime_set_wasi_args_ex(g_host.module,
                                  NULL,
                                  0,
                                  g_wasi_map_ptrs,
                                  g_wasi_map_count,
                                  NULL,
                                  0,
                                  NULL,
                                  0,
                                  -1,
                                  -1,
                                  -1);
}

static uint8_t *read_file(const char *path, size_t *out_size) {
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        TraceLog(LOG_ERROR, "Unable to open %s: %s", path, strerror(errno));
        return NULL;
    }
    if (fseek(fp, 0, SEEK_END) != 0) {
        TraceLog(LOG_ERROR, "Unable to seek %s", path);
        fclose(fp);
        return NULL;
    }
    long size = ftell(fp);
    if (size < 0) {
        TraceLog(LOG_ERROR, "Unable to determine size of %s", path);
        fclose(fp);
        return NULL;
    }
    rewind(fp);
    uint8_t *data = (uint8_t *)malloc((size_t)size);
    if (!data) {
        TraceLog(LOG_ERROR, "Out of memory reading %s", path);
        fclose(fp);
        return NULL;
    }
    size_t read = fread(data, 1, (size_t)size, fp);
    fclose(fp);
    if (read != (size_t)size) {
        TraceLog(LOG_ERROR, "Short read for %s", path);
        free(data);
        return NULL;
    }
    if (out_size) {
        *out_size = (size_t)size;
    }
    return data;
}

static uint32_t wasm_alloc(uint32_t size, void **native_out) {
    if (!g_host.module_inst) {
        return 0;
    }
    void *native_ptr = NULL;
    uint64_t offset = wasm_runtime_module_malloc(g_host.module_inst, size ? size : 1, &native_ptr);
    if (!offset || !native_ptr) {
        if (offset) {
            wasm_runtime_module_free(g_host.module_inst, offset);
        }
        return 0;
    }
    if (native_out) {
        *native_out = native_ptr;
    }
    return (uint32_t)offset;
}

static uint32_t wasm_write_cstring(const char *text) {
    if (!text) {
        return 0;
    }
    size_t len = strlen(text) + 1;
    void *native = NULL;
    uint32_t ptr = wasm_alloc((uint32_t)len, &native);
    if (!ptr) {
        return 0;
    }
    memcpy(native, text, len);
    return ptr;
}

static const char *wasm_cstring(uint32_t offset) {
    if (!offset || !g_host.module_inst) {
        return NULL;
    }
    if (!wasm_runtime_validate_app_str_addr(g_host.module_inst, offset)) {
        return NULL;
    }
    return (const char *)wasm_runtime_addr_app_to_native(g_host.module_inst, offset);
}

static const char *wasm_cstring_inst(wasm_module_inst_t inst, uint32_t offset) {
    if (!offset || !inst) {
        return NULL;
    }
    if (!wasm_runtime_validate_app_str_addr(inst, offset)) {
        return NULL;
    }
    return (const char *)wasm_runtime_addr_app_to_native(inst, offset);
}

static bool call_wasm(wasm_function_inst_t fn, uint32_t argc, uint32_t *argv, const char *name) {
    if (!fn) {
        TraceLog(LOG_ERROR, "Core export %s is missing", name);
        return false;
    }
    if (!wasm_runtime_call_wasm(g_host.exec_env, fn, argc, argv)) {
        const char *exception = wasm_runtime_get_exception(g_host.module_inst);
        TraceLog(LOG_ERROR, "%s trapped: %s", name, exception ? exception : "unknown");
        return false;
    }
    return true;
}

static bool call_noargs(wasm_function_inst_t fn, const char *name) {
    return call_wasm(fn, 0, NULL, name);
}

static void call_optional(const char *name) {
    if (!g_host.module_inst) {
        return;
    }
    wasm_function_inst_t fn = wasm_runtime_lookup_function(g_host.module_inst, name);
    if (!fn) {
        return;
    }
    if (!wasm_runtime_call_wasm(g_host.exec_env, fn, 0, NULL)) {
        const char *exception = wasm_runtime_get_exception(g_host.module_inst);
        TraceLog(LOG_WARNING, "%s trapped: %s", name, exception ? exception : "unknown");
    }
}

static bool resolve_exports(void) {
    g_host.fn_libretro_host_init = wasm_runtime_lookup_function(g_host.module_inst, "libretro_host_init");
    g_host.fn_retro_init = wasm_runtime_lookup_function(g_host.module_inst, "retro_init");
    g_host.fn_retro_run = wasm_runtime_lookup_function(g_host.module_inst, "retro_run");
    g_host.fn_retro_deinit = wasm_runtime_lookup_function(g_host.module_inst, "retro_deinit");
    g_host.fn_retro_load_game = wasm_runtime_lookup_function(g_host.module_inst, "retro_load_game");
    g_host.fn_retro_unload_game = wasm_runtime_lookup_function(g_host.module_inst, "retro_unload_game");
    g_host.fn_retro_get_system_info = wasm_runtime_lookup_function(g_host.module_inst, "retro_get_system_info");
    g_host.fn_retro_get_system_av_info = wasm_runtime_lookup_function(g_host.module_inst, "retro_get_system_av_info");

    if (!g_host.fn_libretro_host_init || !g_host.fn_retro_init || !g_host.fn_retro_run ||
        !g_host.fn_retro_load_game || !g_host.fn_retro_get_system_av_info) {
        TraceLog(LOG_ERROR, "Core is missing required exports");
        return false;
    }
    return true;
}

static bool fetch_system_av_info(retro_system_av_info_host *out) {
    if (!out) {
        return false;
    }
    void *native = NULL;
    uint32_t ptr = wasm_alloc((uint32_t)sizeof(retro_system_av_info_host), &native);
    if (!ptr) {
        return false;
    }
    memset(native, 0, sizeof(retro_system_av_info_host));
    uint32_t argv[1] = { ptr };
    bool ok = call_wasm(g_host.fn_retro_get_system_av_info, 1, argv, "retro_get_system_av_info");
    if (ok) {
        memcpy(out, native, sizeof(retro_system_av_info_host));
    }
    wasm_runtime_module_free(g_host.module_inst, ptr);
    return ok;
}

static void fetch_system_info(char *name, size_t name_cap, char *version, size_t version_cap) {
    if (name && name_cap) {
        name[0] = '\0';
    }
    if (version && version_cap) {
        version[0] = '\0';
    }
    if (!g_host.fn_retro_get_system_info) {
        return;
    }
    void *native = NULL;
    uint32_t ptr = wasm_alloc((uint32_t)sizeof(retro_system_info_wasm), &native);
    if (!ptr) {
        return;
    }
    memset(native, 0, sizeof(retro_system_info_wasm));
    uint32_t argv[1] = { ptr };
    if (!call_wasm(g_host.fn_retro_get_system_info, 1, argv, "retro_get_system_info")) {
        wasm_runtime_module_free(g_host.module_inst, ptr);
        return;
    }
    retro_system_info_wasm info;
    memcpy(&info, native, sizeof(info));
    wasm_runtime_module_free(g_host.module_inst, ptr);
    const char *core_name = wasm_cstring(info.library_name);
    const char *core_version = wasm_cstring(info.library_version);
    if (core_name && name && name_cap) {
        strncpy(name, core_name, name_cap - 1);
        name[name_cap - 1] = '\0';
    }
    if (core_version && version && version_cap) {
        strncpy(version, core_version, version_cap - 1);
        version[version_cap - 1] = '\0';
    }
}

static bool load_game(const char *rom_host_path, const char *rom_guest_path) {
    size_t rom_size = 0;
    uint8_t *rom_data = read_file(rom_host_path, &rom_size);
    if (!rom_data) {
        return false;
    }
    void *rom_native = NULL;
    uint32_t rom_ptr = wasm_alloc((uint32_t)rom_size, &rom_native);
    if (!rom_ptr) {
        free(rom_data);
        return false;
    }
    memcpy(rom_native, rom_data, rom_size);
    free(rom_data);

    uint32_t path_ptr = wasm_write_cstring(rom_guest_path ? rom_guest_path : rom_host_path);
    if (!path_ptr) {
        wasm_runtime_module_free(g_host.module_inst, rom_ptr);
        return false;
    }

    retro_game_info_wasm info = {
        .path = path_ptr,
        .data = rom_ptr,
        .size = (uint32_t)rom_size,
        .meta = 0,
    };

    void *info_native = NULL;
    uint32_t info_ptr = wasm_alloc((uint32_t)sizeof(info), &info_native);
    if (!info_ptr) {
        wasm_runtime_module_free(g_host.module_inst, rom_ptr);
        return false;
    }
    memcpy(info_native, &info, sizeof(info));

    uint32_t argv[1] = { info_ptr };
    if (!call_wasm(g_host.fn_retro_load_game, 1, argv, "retro_load_game")) {
        wasm_runtime_module_free(g_host.module_inst, info_ptr);
        wasm_runtime_module_free(g_host.module_inst, rom_ptr);
        return false;
    }

    g_host.rom_data_ptr = rom_ptr;
    g_host.rom_path_ptr = path_ptr;
    g_host.game_info_ptr = info_ptr;
    g_host.game_loaded = true;
    return true;
}

static void unload_game(void) {
    if (g_host.game_loaded && g_host.fn_retro_unload_game) {
        call_noargs(g_host.fn_retro_unload_game, "retro_unload_game");
    }
    if (g_host.game_info_ptr) {
        wasm_runtime_module_free(g_host.module_inst, g_host.game_info_ptr);
        g_host.game_info_ptr = 0;
    }
    if (g_host.rom_data_ptr) {
        wasm_runtime_module_free(g_host.module_inst, g_host.rom_data_ptr);
        g_host.rom_data_ptr = 0;
    }
    if (g_host.rom_path_ptr) {
        wasm_runtime_module_free(g_host.module_inst, g_host.rom_path_ptr);
        g_host.rom_path_ptr = 0;
    }
    g_host.game_loaded = false;
}

static bool ensure_framebuffer(unsigned width, unsigned height) {
    if (width == 0 || height == 0) {
        return false;
    }
    size_t pixels = (size_t)width * (size_t)height;
    if (pixels > g_host.framebuffer_capacity) {
        uint16_t *newbuf = (uint16_t *)realloc(g_host.framebuffer, pixels * sizeof(uint16_t));
        if (!newbuf) {
            TraceLog(LOG_ERROR, "Failed to allocate framebuffer");
            return false;
        }
        g_host.framebuffer = newbuf;
        g_host.framebuffer_capacity = pixels;
    }
    if (!g_host.texture_ready || width != g_host.fb_width || height != g_host.fb_height) {
        if (g_host.texture_ready) {
            UnloadTexture(g_host.texture);
            g_host.texture_ready = false;
        }
        Image image = {
            .data = g_host.framebuffer,
            .width = (int)width,
            .height = (int)height,
            .mipmaps = 1,
            .format = PIXELFORMAT_UNCOMPRESSED_R5G6B5,
        };
        g_host.texture = LoadTextureFromImage(image);
        g_host.texture_ready = true;
        g_host.fb_width = width;
        g_host.fb_height = height;
    }
    return true;
}

static void render_frame(void) {
    BeginDrawing();
    ClearBackground(BLACK);
    if (g_host.texture_ready) {
        float win_w = (float)GetScreenWidth();
        float win_h = (float)GetScreenHeight();
        float aspect = 0.0f;
        if (g_host.display_aspect > 0.0) {
            aspect = (float)g_host.display_aspect;
        } else if (g_host.fb_height > 0) {
            aspect = (float)g_host.fb_width / (float)g_host.fb_height;
        } else {
            aspect = 4.0f / 3.0f;
        }
        float draw_w = win_w;
        float draw_h = draw_w / aspect;
        if (draw_h > win_h) {
            draw_h = win_h;
            draw_w = draw_h * aspect;
        }
        if (draw_w <= 0.0f || draw_h <= 0.0f) {
            draw_w = (float)g_host.fb_width;
            draw_h = (float)g_host.fb_height;
        }
        Rectangle src = { 0.0f, 0.0f, (float)g_host.fb_width, (float)g_host.fb_height };
        Rectangle dst = {
            (win_w - draw_w) * 0.5f,
            (win_h - draw_h) * 0.5f,
            draw_w,
            draw_h,
        };
        DrawTexturePro(g_host.texture, src, dst, (Vector2){ 0.0f, 0.0f }, 0.0f, WHITE);
    } else {
        DrawText("Waiting for video…", 32, 32, 20, RAYWHITE);
    }
    EndDrawing();
}

static bool init_audio(double device_rate) {
    if (device_rate <= 0.0) {
        device_rate = AUDIO_DEVICE_SAMPLE_RATE;
    }
    g_host.device_sample_rate = device_rate;
    if (!g_host.resample_fifo.data && g_host.resample_fifo.capacity == 0) {
        sample_fifo_init(&g_host.resample_fifo);
    }
    reset_resampler_state();
    int channels = 2;
    double frames_per_second = g_host.frame_rate > 0.0 ? g_host.frame_rate : 60.0;
    double chunks_per_frame = AUDIO_CHUNKS_PER_FRAME;
    if (chunks_per_frame <= 0.0) {
        chunks_per_frame = 1.0;
    }
    int chunk_frames = (int)ceil(device_rate / (frames_per_second * chunks_per_frame));
    if (chunk_frames < AUDIO_MIN_CHUNK_FRAMES) {
        chunk_frames = AUDIO_MIN_CHUNK_FRAMES;
    } else if (chunk_frames > AUDIO_MAX_CHUNK_FRAMES) {
        chunk_frames = AUDIO_MAX_CHUNK_FRAMES;
    }
    size_t chunk_samples = (size_t)chunk_frames * (size_t)channels;
    size_t initial_capacity = chunk_samples * AUDIO_RING_CHUNKS;
    if (!audio_ring_init(&g_host.audio_queue, initial_capacity)) {
        TraceLog(LOG_WARNING, "Unable to allocate audio queue; audio disabled");
        return false;
    }
    g_host.audio_chunk = (int16_t *)malloc(chunk_samples * sizeof(int16_t));
    if (!g_host.audio_chunk) {
        TraceLog(LOG_WARNING, "Unable to allocate audio staging buffer");
        audio_ring_free(&g_host.audio_queue);
        return false;
    }
    memset(g_host.audio_chunk, 0, chunk_samples * sizeof(int16_t));
    InitAudioDevice();
    SetAudioStreamBufferSizeDefault(chunk_frames);
    AudioStream stream = LoadAudioStream((unsigned int)device_rate, 16, channels);
    if (!IsAudioStreamValid(stream)) {
        TraceLog(LOG_WARNING, "Unable to create audio stream");
        CloseAudioDevice();
        free(g_host.audio_chunk);
        g_host.audio_chunk = NULL;
        audio_ring_free(&g_host.audio_queue);
        return false;
    }
    PlayAudioStream(stream);
    for (int i = 0; i < 4; ++i) {
        UpdateAudioStream(stream, g_host.audio_chunk, chunk_frames);
    }
    g_host.audio_stream = stream;
    g_host.audio_ready = true;
    g_host.sample_rate = device_rate;
    g_host.audio_chunk_frames = chunk_frames;
    g_host.audio_channels = channels;
    g_host.audio_started = false;
    return true;
}

static void update_audio_sample_rate(double sample_rate) {
    if (sample_rate <= 0.0) {
        sample_rate = g_host.source_sample_rate > 0.0 ? g_host.source_sample_rate : AUDIO_DEVICE_SAMPLE_RATE;
    }
    if (!g_host.audio_ready) {
        if (!init_audio(AUDIO_DEVICE_SAMPLE_RATE)) {
            TraceLog(LOG_WARNING, "Audio disabled (init failed)");
            return;
        }
    }
    g_host.source_sample_rate = sample_rate;
    if (g_host.device_sample_rate <= 0.0) {
        g_host.device_sample_rate = AUDIO_DEVICE_SAMPLE_RATE;
    }
    g_host.resample_ratio = g_host.source_sample_rate / g_host.device_sample_rate;
    reset_resampler_state();
}

static void apply_system_av_info(const retro_system_av_info_host *info) {
    if (!info) {
        return;
    }
    g_host.current_av_info = *info;
    g_host.av_info_valid = true;
    if (info->geometry.aspect_ratio > 0.0f) {
        g_host.display_aspect = (double)info->geometry.aspect_ratio;
    } else if (info->geometry.base_height > 0) {
        g_host.display_aspect = (double)info->geometry.base_width / (double)info->geometry.base_height;
    }
    update_frame_timing(info->timing.fps);
    update_audio_sample_rate(info->timing.sample_rate);
}

static void pump_audio(void) {
    service_audio_stream(8, true);
}

static void shutdown_platform(void) {
    destroy_audio_stream();
    if (g_host.texture_ready) {
        UnloadTexture(g_host.texture);
        g_host.texture_ready = false;
    }
    free(g_host.framebuffer);
    g_host.framebuffer = NULL;
    g_host.framebuffer_capacity = 0;
    if (IsWindowReady()) {
        CloseWindow();
    }
}

static void shutdown_runtime(void) {
    unload_game();
    reset_core_option_cache();
    if (g_host.fn_retro_deinit) {
        call_noargs(g_host.fn_retro_deinit, "retro_deinit");
    }
    if (g_host.system_dir_ptr) {
        wasm_runtime_module_free(g_host.module_inst, g_host.system_dir_ptr);
        g_host.system_dir_ptr = 0;
    }
    if (g_host.exec_env) {
        wasm_runtime_destroy_exec_env(g_host.exec_env);
        g_host.exec_env = NULL;
    }
    if (g_host.module_inst) {
        wasm_runtime_deinstantiate(g_host.module_inst);
        g_host.module_inst = NULL;
    }
    if (g_host.module) {
        wasm_runtime_unload(g_host.module);
        g_host.module = NULL;
    }
    if (g_host.runtime_ready) {
        wasm_runtime_destroy();
        g_host.runtime_ready = false;
    }
    free(g_host.runtime_heap);
    g_host.runtime_heap = NULL;
    free(g_host.core_bytes);
    g_host.core_bytes = NULL;
}

static int32_t host_environment(wasm_exec_env_t exec_env, int32_t cmd, int32_t data_ptr);
static void host_video_refresh(wasm_exec_env_t exec_env, int32_t data_ptr, int32_t width, int32_t height, int32_t pitch);
static void host_audio_sample(wasm_exec_env_t exec_env, int32_t left, int32_t right);
static int32_t host_audio_sample_batch(wasm_exec_env_t exec_env, int32_t data_ptr, int32_t frames);
static void host_input_poll(wasm_exec_env_t exec_env);
static int32_t host_input_state(wasm_exec_env_t exec_env, int32_t port, int32_t device, int32_t index, int32_t id);

static NativeSymbol native_symbols[] = {
    { "environment", (void *)host_environment, "(ii)i", NULL },
    { "video_refresh", (void *)host_video_refresh, "(iiii)", NULL },
    { "audio_sample", (void *)host_audio_sample, "(ii)", NULL },
    { "audio_sample_batch", (void *)host_audio_sample_batch, "(ii)i", NULL },
    { "input_poll", (void *)host_input_poll, "()", NULL },
    { "input_state", (void *)host_input_state, "(iiii)i", NULL },
};

static const int native_symbols_size = (int)(sizeof(native_symbols) / sizeof(native_symbols[0]));

static int32_t host_environment(wasm_exec_env_t exec_env, int32_t cmd, int32_t data_ptr) {
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    switch ((uint32_t)cmd) {
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
            if (!data_ptr || !inst) {
                return 0;
            }
            if (!wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(uint32_t))) {
                return 0;
            }
            uint32_t *fmt = wasm_runtime_addr_app_to_native(inst, data_ptr);
            if (*fmt == RETRO_PIXEL_FORMAT_RGB565) {
                g_host.pixel_format_rgb565 = true;
                return 1;
            }
            TraceLog(LOG_ERROR, "Unsupported pixel format %u", *fmt);
            return 0;
        }
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: {
            if (!data_ptr || !inst) {
                return 0;
            }
            if (!wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(uint32_t))) {
                return 0;
            }
            if (!g_host.system_dir_ptr) {
                char buffer[PATH_MAX];
#if defined(_WIN32)
                if (!_getcwd(buffer, (int)sizeof(buffer))) {
                    strncpy(buffer, ".", sizeof(buffer));
                }
#else
                if (!getcwd(buffer, sizeof(buffer))) {
                    strncpy(buffer, ".", sizeof(buffer));
                }
#endif
                buffer[sizeof(buffer) - 1] = '\0';
                g_host.system_dir_ptr = wasm_write_cstring(buffer);
            }
            uint32_t *out = wasm_runtime_addr_app_to_native(inst, data_ptr);
            *out = g_host.system_dir_ptr;
            return 1;
        }
        case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
        case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
        case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
        case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
        case RETRO_ENVIRONMENT_SET_ROTATION:
            return 1;
        case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
            if (!data_ptr || !inst) {
                return 0;
            }
            if (!wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(retro_system_av_info_host))) {
                return 0;
            }
            retro_system_av_info_host info;
            memcpy(&info, wasm_runtime_addr_app_to_native(inst, data_ptr), sizeof(info));
            apply_system_av_info(&info);
            return 1;
        }
        case RETRO_ENVIRONMENT_GET_CAN_DUPE: {
            if (data_ptr && inst && wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(uint8_t))) {
                uint8_t *flag = wasm_runtime_addr_app_to_native(inst, data_ptr);
                *flag = 1;
            }
            return 1;
        }
        case RETRO_ENVIRONMENT_GET_LANGUAGE: {
            if (!data_ptr || !inst) {
                return 0;
            }
            if (!wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(uint32_t))) {
                return 0;
            }
            uint32_t *out = wasm_runtime_addr_app_to_native(inst, data_ptr);
            *out = 0; // RETRO_LANGUAGE_ENGLISH
            return 1;
        }
        case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE: {
            if (!data_ptr || !inst) {
                return 0;
            }
            if (!wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(uint32_t))) {
                return 0;
            }
            uint32_t *out = wasm_runtime_addr_app_to_native(inst, data_ptr);
            *out = 1 | 2;
            return 1;
        }
        case RETRO_ENVIRONMENT_SET_VARIABLES:
        case RETRO_ENVIRONMENT_SET_VARIABLE:
            return 1;
        case RETRO_ENVIRONMENT_GET_VARIABLE: {
            if (!data_ptr || !inst) {
                return 0;
            }
            if (!wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(uint32_t) * 2)) {
                return 0;
            }
            uint32_t *fields = wasm_runtime_addr_app_to_native(inst, data_ptr);
            const char *key = wasm_cstring_inst(inst, fields[0]);
            if (!key) {
                fields[1] = 0;
                return 1;
            }
            if (strcmp(key, "ngp_language") == 0) {
                if (!g_host.option_ngp_language_ptr) {
                    g_host.option_ngp_language_ptr = wasm_write_cstring("english");
                }
                fields[1] = g_host.option_ngp_language_ptr;
                return 1;
            }
            fields[1] = 0;
            return 1;
        }
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: {
            if (data_ptr && inst && wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(uint8_t))) {
                uint8_t *flag = wasm_runtime_addr_app_to_native(inst, data_ptr);
                *flag = 0;
            }
            return 1;
        }
        case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL:
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
        case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
            return 0;
        case RETRO_ENVIRONMENT_SET_MESSAGE: {
            if (!data_ptr || !inst) {
                return 0;
            }
            if (!wasm_runtime_validate_app_addr(inst, data_ptr, sizeof(uint32_t) * 2)) {
                return 0;
            }
            uint32_t *fields = wasm_runtime_addr_app_to_native(inst, data_ptr);
            const char *msg = wasm_cstring_inst(inst, fields[0]);
            if (msg) {
                TraceLog(LOG_INFO, "Core message: %s", msg);
            }
            return 1;
        }
        case RETRO_ENVIRONMENT_SET_MESSAGE_EXT:
            return 1;
        case RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION:
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
            return 0;
        default:
            return 0;
    }
}

static void host_video_refresh(wasm_exec_env_t exec_env, int32_t data_ptr, int32_t width, int32_t height, int32_t pitch) {
    if (width <= 0 || height <= 0 || data_ptr == 0 || data_ptr == (int32_t)RETRO_HW_FRAME_BUFFER_VALID) {
        return;
    }
    if (!g_host.pixel_format_rgb565) {
        TraceLog(LOG_WARNING, "Core is emitting frames before specifying RGB565 format; assuming RGB565");
        g_host.pixel_format_rgb565 = true;
    }
    if (!ensure_framebuffer((unsigned)width, (unsigned)height)) {
        return;
    }
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    if (!inst) {
        return;
    }
    size_t stride = (size_t)pitch;
    size_t needed = stride * (size_t)height;
    if (!wasm_runtime_validate_app_addr(inst, data_ptr, needed)) {
        return;
    }
    uint8_t *src = wasm_runtime_addr_app_to_native(inst, data_ptr);
    uint16_t *dst = g_host.framebuffer;
    size_t row_bytes = (size_t)width * sizeof(uint16_t);
    for (int32_t y = 0; y < height; ++y) {
        memcpy(dst + (size_t)y * (size_t)width, src + (size_t)y * stride, row_bytes);
    }
    UpdateTexture(g_host.texture, g_host.framebuffer);
}

static void host_audio_sample(wasm_exec_env_t exec_env, int32_t left, int32_t right) {
    (void)exec_env;
    if (!g_host.audio_ready) {
        return;
    }
    int16_t pair[2] = { (int16_t)left, (int16_t)right };
    queue_resampled_audio(pair, 1);
    service_audio_stream(4, false);
}

static int32_t host_audio_sample_batch(wasm_exec_env_t exec_env, int32_t data_ptr, int32_t frames) {
    if (!g_host.audio_ready || frames <= 0 || !data_ptr) {
        return 0;
    }
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    size_t samples = (size_t)frames * 2;
    size_t bytes = samples * sizeof(int16_t);
    if (!wasm_runtime_validate_app_addr(inst, data_ptr, bytes)) {
        return 0;
    }
    const int16_t *src = wasm_runtime_addr_app_to_native(inst, data_ptr);
    queue_resampled_audio(src, (size_t)frames);
    service_audio_stream(4, false);
    return frames;
}

static void host_input_poll(wasm_exec_env_t exec_env) {
    (void)exec_env;
}

static int32_t host_input_state(wasm_exec_env_t exec_env, int32_t port, int32_t device, int32_t index, int32_t id) {
    (void)exec_env;
    (void)index;
    if (port != 0 || device != RETRO_DEVICE_JOYPAD) {
        return 0;
    }
    switch (id) {
        case RETRO_DEVICE_ID_JOYPAD_B:
            return IsKeyDown(KEY_Z);
        case RETRO_DEVICE_ID_JOYPAD_A:
            return IsKeyDown(KEY_X);
        case RETRO_DEVICE_ID_JOYPAD_Y:
            return IsKeyDown(KEY_A);
        case RETRO_DEVICE_ID_JOYPAD_X:
            return IsKeyDown(KEY_S);
        case RETRO_DEVICE_ID_JOYPAD_L:
            return IsKeyDown(KEY_Q);
        case RETRO_DEVICE_ID_JOYPAD_R:
            return IsKeyDown(KEY_W);
        case RETRO_DEVICE_ID_JOYPAD_SELECT:
            return IsKeyDown(KEY_RIGHT_SHIFT) || IsKeyDown(KEY_LEFT_SHIFT) || IsKeyDown(KEY_SPACE);
        case RETRO_DEVICE_ID_JOYPAD_START:
            return IsKeyDown(KEY_ENTER);
        case RETRO_DEVICE_ID_JOYPAD_UP:
            return IsKeyDown(KEY_UP);
        case RETRO_DEVICE_ID_JOYPAD_DOWN:
            return IsKeyDown(KEY_DOWN);
        case RETRO_DEVICE_ID_JOYPAD_LEFT:
            return IsKeyDown(KEY_LEFT);
        case RETRO_DEVICE_ID_JOYPAD_RIGHT:
            return IsKeyDown(KEY_RIGHT);
        default:
            return 0;
    }
}

static bool init_runtime(void) {
    g_host.runtime_heap = malloc(RUNTIME_HEAP_SIZE);
    if (!g_host.runtime_heap) {
        TraceLog(LOG_ERROR, "Unable to allocate runtime heap");
        return false;
    }
    RuntimeInitArgs init_args;
    memset(&init_args, 0, sizeof(init_args));
    init_args.mem_alloc_type = Alloc_With_Pool;
    init_args.mem_alloc_option.pool.heap_buf = g_host.runtime_heap;
    init_args.mem_alloc_option.pool.heap_size = RUNTIME_HEAP_SIZE;
    init_args.max_thread_num = 1;
    init_args.native_module_name = "libretro_host";
    init_args.native_symbols = native_symbols;
    init_args.n_native_symbols = native_symbols_size;

    if (!wasm_runtime_full_init(&init_args)) {
        TraceLog(LOG_ERROR, "wasm_runtime_full_init failed");
        return false;
    }
    g_host.runtime_ready = true;
    return true;
}

static bool instantiate_module(const char *rom_dir) {
    if (!g_host.core_bytes || !g_host.core_size) {
        return false;
    }
    char error_buf[128];
    g_host.module = wasm_runtime_load(g_host.core_bytes, (uint32_t)g_host.core_size, error_buf, sizeof(error_buf));
    if (!g_host.module) {
        TraceLog(LOG_ERROR, "Unable to load core: %s", error_buf);
        return false;
    }
    configure_wasi_for_rom_dir(rom_dir);
    g_host.module_inst = wasm_runtime_instantiate(g_host.module, MODULE_STACK_SIZE, MODULE_HEAP_SIZE, error_buf, sizeof(error_buf));
    if (!g_host.module_inst) {
        TraceLog(LOG_ERROR, "Unable to instantiate core: %s", error_buf);
        return false;
    }
    g_host.option_ngp_language_ptr = 0;
    g_host.exec_env = wasm_runtime_create_exec_env(g_host.module_inst, MODULE_STACK_SIZE);
    if (!g_host.exec_env) {
        TraceLog(LOG_ERROR, "Unable to create execution environment");
        return false;
    }
    return true;
}

static void setup_window(const retro_system_av_info_host *av_info, const char *core_name, const char *rom_path) {
    unsigned width = av_info && av_info->geometry.base_width ? av_info->geometry.base_width : 640;
    unsigned height = av_info && av_info->geometry.base_height ? av_info->geometry.base_height : 480;
    SetConfigFlags(FLAG_WINDOW_RESIZABLE | FLAG_VSYNC_HINT);
    InitWindow((int)width, (int)height, "libretro-wasm");
    SetWindowMinSize(160, 144);
    const char *rom_base = path_basename(rom_path);
    if (core_name && core_name[0]) {
        snprintf(g_host.window_title, sizeof(g_host.window_title), "%s - %s", core_name, rom_base);
    } else {
        snprintf(g_host.window_title, sizeof(g_host.window_title), "libretro-wasm - %s", rom_base);
    }
    SetWindowTitle(g_host.window_title);
}

int main(int argc, char *argv[]) {
    SetTraceLogLevel(LOG_INFO);
    g_host.frame_rate = 60.0;
    g_host.sample_rate = 48000.0;
    g_host.display_aspect = 4.0 / 3.0;
    if (argc != 3) {
        TraceLog(LOG_ERROR, "Usage: %s <core.wasm> <rom>", argv[0]);
        return 1;
    }

    char core_realpath[PATH_MAX];
    char rom_realpath[PATH_MAX];
    if (!make_absolute_path(argv[1], core_realpath, sizeof(core_realpath))) {
        TraceLog(LOG_ERROR, "Unable to resolve core path: %s", argv[1]);
        return 1;
    }
    if (!make_absolute_path(argv[2], rom_realpath, sizeof(rom_realpath))) {
        TraceLog(LOG_ERROR, "Unable to resolve rom path: %s", argv[2]);
        return 1;
    }

    const char *core_path = core_realpath;
    const char *rom_path = rom_realpath;

    g_host.core_bytes = read_file(core_path, &g_host.core_size);
    if (!g_host.core_bytes) {
        return 1;
    }

    strncpy(g_host.host_rom_path, rom_path, sizeof(g_host.host_rom_path) - 1);
    g_host.host_rom_path[sizeof(g_host.host_rom_path) - 1] = '\0';
    path_dirname_copy(rom_path, g_host.rom_directory, sizeof(g_host.rom_directory));
    const char *rom_base = path_basename(rom_path);
    snprintf(g_host.guest_rom_path, sizeof(g_host.guest_rom_path), "/rom/%s", rom_base);

    bool success = false;

    if (!init_runtime()) {
        goto cleanup;
    }
    if (!instantiate_module(g_host.rom_directory)) {
        goto cleanup;
    }
    if (!resolve_exports()) {
        goto cleanup;
    }

    call_optional("__wasm_call_ctors");
    call_optional("_initialize");

    if (!call_noargs(g_host.fn_libretro_host_init, "libretro_host_init")) {
        goto cleanup;
    }
    if (!call_noargs(g_host.fn_retro_init, "retro_init")) {
        goto cleanup;
    }
    if (!load_game(g_host.host_rom_path, g_host.guest_rom_path)) {
        goto cleanup;
    }

    retro_system_av_info_host av_info;
    if (!fetch_system_av_info(&av_info)) {
        goto cleanup;
    }
    apply_system_av_info(&av_info);

    char core_name[128] = {0};
    fetch_system_info(core_name, sizeof(core_name), NULL, 0);
    setup_window(&av_info, core_name, g_host.host_rom_path);
    update_frame_timing(g_host.frame_rate);

    g_host.running = true;
    while (g_host.running && !WindowShouldClose()) {
        if (!call_noargs(g_host.fn_retro_run, "retro_run")) {
            g_host.running = false;
            break;
        }
        pump_audio();
        render_frame();
    }

    success = g_host.running;

cleanup:
    shutdown_platform();
    shutdown_runtime();
    return success ? 0 : 1;
}

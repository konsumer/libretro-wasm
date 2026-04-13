#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <raylib.h>
#include <wasm_export.h>

// host imports look like this
// static const int native_symbols_size = 2;
// static NativeSymbol native_symbols[native_symbols_size] = {
//     {
//         "foo",      // the name of WASM function name
//         foo_native, // the native function pointer
//         "(ii)i"     // the function prototype signature
//     },
//     {
//         "foo2",         // the name of WASM function name
//         foo2,           // the native function pointer
//         "($*~)"         // the function prototype signature
//     }
// };

static const int native_symbols_size = 0;
static NativeSymbol native_symbols[native_symbols_size] = {};

static uint32_t stack_size = 1024 * 1024 * 10; // 10 MB
static uint32_t heap_size = 1024 * 1024 * 10;  // 10 MB
static wasm_module_t module = NULL;
static wasm_module_inst_t module_inst = NULL;
static wasm_exec_env_t exec_env = NULL;

// exports from wasm look like this
// static wasm_function_inst_t wasm_core_whatever = NULL;

int main(int argc, char *argv[]) {
    if (argc != 3) {
        TraceLog(LOG_ERROR, "Usage: %s <wasm_core> <rom_file>\n", argv[0]);
        return 1;
    }

    char *wasm_core = argv[1];
    char *rom_file = argv[2];

    // load the wasm core
    FILE *file = fopen(wasm_core, "rb");
    if (file == NULL) {
        TraceLog(LOG_ERROR, "Could not load wasm libretro core.");
        return 1;
    }
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    rewind(file);
    unsigned char *wasmBytes = (unsigned char *)malloc(size);
    if (wasmBytes == NULL) {
        TraceLog(LOG_ERROR, "Could not load (allocate) wasm libretro core.");
        fclose(file);
        return 1;
    }
    size_t wasmSize = fread(wasmBytes, 1, size, file);
    free(wasmBytes);
    fclose(file);


    // I think there is some WASI header that comes with WAMR that has wasi_set_args
    // wasi_set_args(argc, argv);
    
    void *heap_buf = malloc(16 * 1024 * 1024);
    if (!heap_buf) {
        TraceLog(LOG_ERROR, "Failed to allocate heap buffer");
        return 1;
    }

    char error_buf[128];
    RuntimeInitArgs init_args = {0};

    init_args.mem_alloc_type = Alloc_With_Pool;
    init_args.mem_alloc_option.pool.heap_buf = heap_buf;
    init_args.mem_alloc_option.pool.heap_size = 16 * 1024 * 1024;
    init_args.max_thread_num = 1;

    if (!wasm_runtime_full_init(&init_args)) {
        TraceLog(LOG_ERROR, "init: runtime");
        free(heap_buf);
        return 1;
    }

    // host imports look like this
    if (!wasm_runtime_register_natives("env", native_symbols, native_symbols_size)) {
        TraceLog(LOG_ERROR, "core: register");
        return 1;
    }

    // Load WASM module
    module = wasm_runtime_load(wasmBytes, wasmSize, error_buf, sizeof(error_buf));
    if (!module) {
        TraceLog(LOG_ERROR, error_buf);
        wasm_runtime_destroy();
        return 1;
    }

    // Instantiate the module
    module_inst = wasm_runtime_instantiate(module, stack_size, heap_size, error_buf, sizeof(error_buf));
    if (!module_inst) {
        TraceLog(LOG_ERROR, error_buf);
        wasm_runtime_unload(module);
        wasm_runtime_destroy();
        return 1;
    }

    // Create execution environment
    exec_env = wasm_runtime_create_exec_env(module_inst, stack_size);
    if (!exec_env) {
        TraceLog(LOG_ERROR, wasm_runtime_get_exception(module_inst));
        wasm_runtime_deinstantiate(module_inst);
        wasm_runtime_unload(module);
        wasm_runtime_destroy();
        return 1;
    }

    // exports from wasm core look like this
    // wasm_core_whatever = wasm_runtime_lookup_function(module_inst, "whatever");

    // call them like this
    // wasm_runtime_call_wasm(exec_env, wasm_core_whatever, 0, NULL);


    InitWindow(256, 240, TextFormat("libretro-wasm: %s - %s", GetFileNameWithoutExt(wasm_core), GetFileNameWithoutExt(rom_file)));

    SetTargetFPS(60);
    while (!WindowShouldClose()) {
        BeginDrawing();
        ClearBackground(RAYWHITE);
        DrawText("ROM goes here", 50, 110, 20, LIGHTGRAY);
        EndDrawing();
    }
    CloseWindow();
    return 0;
}

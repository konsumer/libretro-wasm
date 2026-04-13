#include <stdio.h>

int main(int argc, char *argv[]) {
    if (argc != 3) {
        printf("Usage: %s <wasm_core> <rom_file>\n", argv[0]);
        return 1;
    }

    // 2. Access the parameters
    char *wasm_core = argv[1];
    char *rom_file = argv[2];

    printf("Wasm Core Loaded: %s\n", wasm_core);
    printf("ROM File Loaded: %s\n", rom_file);


    return 0;
}
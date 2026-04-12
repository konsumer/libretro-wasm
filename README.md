# libretro-wasm host

This repository contains a lightweight JavaScript frontend that can load libretro cores compiled to WebAssembly.

The host is responsible for:

- Instantiating a libretro core `.wasm` module with the required imports (WASI, libc shims, etc.).
- Exporting every callback described in `libretro.h` (environment, video, audio, input) via the WebAssembly function table so that the core can call back into the frontend.
- Providing helpers to push data into the core's linear memory (ROMs, metadata) and to read frame/audio buffers back out.

## Usage

```js
import { LibretroHost } from "./src/libretro-host.js";

const host = new LibretroHost({
  callbacks: {
    videoRefresh(frame, width, height, pitch) {
      // `frame` is a Uint8Array view into the core framebuffer.
    },
    audioSample(left, right) {
      // Consume 16-bit PCM sample pair.
    },
    inputState({ port, device, index, id }) {
      // Return the current state for the requested control.
      return 0;
    },
  },
});

await host.load(await fs.promises.readFile("./core.wasm"), {
  imports: {
    wasi_snapshot_preview1: createWasiImports(),
  },
});

host.initializeCore();
host.loadGame({ path: "game.rom", data: await fs.promises.readFile("./game.rom") });

while (true) {
  host.runFrame();
}
```

The host inspects the instantiated module, exports all callback entrypoints defined in `libretro.h`, and exposes helpers for allocating strings/buffers in the core's linear memory so that ROMs or save data can be passed across.

## Sample WASI core

A minimal reference core lives in `core/minicore.c`. It draws a simple color band, emits silence, and treats every libretro callback exactly the way a real core would so you can validate the host.

Build it with [wasi-sdk](https://github.com/WebAssembly/wasi-sdk):

```bash
export WASI_SDK_PATH=/path/to/wasi-sdk-24.0
make
```

The build produces `dist/minicore.wasm`, exporting all libretro entry points and the function table so `LibretroHost` can register callbacks. Point the host to that file (via `LibretroHost.fromFile("dist/minicore.wasm")`) to verify end-to-end behavior.

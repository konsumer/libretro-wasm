# libretro-wasm host

This repository contains a lightweight JavaScript frontend that can load libretro cores compiled to WebAssembly.

The host is responsible for:

- Instantiating a libretro core `.wasm` module with the required imports (WASI, libc shims, etc.).
- Exporting every callback described in `libretro.h` (environment, video, audio, input) via the WebAssembly function table so that the core can call back into the frontend.
- Providing helpers to push data into the core's linear memory (ROMs, metadata) and to read frame/audio buffers back out.

## Cloning the repository

This project relies on libretro cores that live under `third_party/` as Git submodules. Clone with submodules to ensure everything needed for the build is present:

```bash
git clone --recurse-submodules https://github.com/<your>/<repo>.git
```

If you already cloned the repo, pull the submodules once:

```bash
git submodule update --init --recursive
```

Submodules currently tracked:

- `third_party/quicknes` → [libretro/QuickNES_Core](https://github.com/libretro/QuickNES_Core)
- `third_party/libretro-2048` → [libretro/libretro-2048](https://github.com/libretro/libretro-2048)

## Usage

```js
import { LibretroHost } from "./src/libretro-host.js";
import { createWasiImports } from "./src/wasi.js";

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

const wasi = createWasiImports();
await host.load(await fs.promises.readFile("./core.wasm"), { imports: wasi.imports });
wasi.setMemory(host.memory);

host.initializeCore();
host.loadGame({ path: "game.rom", data: await fs.promises.readFile("./game.rom") });

while (true) {
  host.runFrame();
}
```

The host inspects the instantiated module, exports all callback entrypoints defined in `libretro.h`, and exposes helpers for allocating strings/buffers in the core's linear memory so that ROMs or save data can be passed across.

### WASI imports

`createWasiImports(options?)` returns a small runtime that keeps libretro cores compiled with `wasi-sdk` happy inside browsers or other JS environments that lack the System Interface. It returns an object with:

- `imports`: pass this object into `LibretroHost.load({ imports })`.
- `setMemory(memory)`: call this right after `host.load(...)` so the WASI shims can see the core's linear memory.
- `initialize(instance)`: convenience helper that accepts the `WebAssembly.Instance` produced by `LibretroHost` and automatically binds the exported memory.

You can optionally pass `{ args, env, stdout, stderr }` to mirror POSIX-style arguments, custom environment variables, or reroute stdout/stderr.

## Sample WASI core

A minimal reference core lives in `core/minicore.c`. It draws a simple color band, emits silence, and treats every libretro callback exactly the way a real core would so you can validate the host.

Build it with [wasi-sdk](https://github.com/WebAssembly/wasi-sdk):

```bash
export WASI_SDK_PATH=/path/to/wasi-sdk-24.0
make
```

The build produces `dist/minicore.wasm`, exporting all libretro entry points and the function table so `LibretroHost` can register callbacks. Point the host to that file (via `LibretroHost.fromFile("dist/minicore.wasm")`) to verify end-to-end behavior.

## QuickNES WASI core

A fully-fledged libretro core is tracked via the `third_party/quicknes` submodule (licensed under GPLv2). The top-level `Makefile` can compile it directly with `wasi-sdk`:

```bash
export WASI_SDK_PATH=/path/to/wasi-sdk-24.0
make dist/quicknes.wasm
```

The resulting `dist/quicknes.wasm` is the unmodified QuickNES core built for the `wasm32-wasi` target. Because it is compiled with wasi-sdk (not Emscripten), it can be loaded in Node.js or in the browser via the WASI shim shipped in `src/wasi.js`.

## Browser example

`examples/browser` hosts a complete front-end that:

- Instantiates `dist/quicknes.wasm` with the WASI shim.
- Streams RGB565 frames into a `<canvas>`.
- Queues 44.1 kHz stereo audio via the Web Audio API.
- Implements libretro environment callbacks so the core can configure pixel formats, options, and messages.

Steps:

```bash
export WASI_SDK_PATH=/path/to/wasi-sdk-24.0
make dist/quicknes.wasm
npx http-server . -c-1  # or any static file server rooted at the repo
```

Then open `http://localhost:8080/examples/browser/` (adjust for your server) and load any homebrew/public-domain `.nes` ROM from your machine. Use the keyboard bindings listed in the UI (arrows/Z/X/Enter/Shift). The WASI shim ensures the QuickNES core behaves exactly like it would inside RetroArch, but fully inside the browser without Emscripten glue.

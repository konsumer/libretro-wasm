# libretro-wasm host

Libretro cores compiled with `wasi-sdk` can run directly in modern browsers and Node.js and native. This repository provides:

- **`web/libretro-host.js`** – a thin frontend that instantiates a core, feeds it games, and surfaces video/audio/input callbacks.
- **`cores/`** – CMake targets that build the in-tree `minicore` sample and the upstream QuickNES core as `.wasm` binaries.
- **`web/`** – a self-contained demo UI that loads `build/cores/quicknes.wasm`, streams RGB565 frames to a `<canvas>`, queues audio, and handles libretro environment requests.
- **`native/`** - a native runtime that can load the wasm core, and play it using raylib

## Requirements

- [wasi-sdk 22+](https://github.com/WebAssembly/wasi-sdk) (the default toolchain auto-detects `/opt/wasi-sdk` or `$WASI_SDK_PREFIX`).
- CMake ≥ 3.18 and a recent `clang` (provided by wasi-sdk).
- Node.js ≥ 18 for the optional dev server.

## Building the cores

```bash
npm run cores
```

Artifacts live under `build/cores/cores/`. The QuickNES target is fetched automatically with `FetchContent`, so no Git submodules are needed.

## Building the native host

Artifacts live under `build/native/`.

```bash
npm run native
```


## Running the browser demo

This builds the cores, and runs a local dev-server.

```bash
npm run start
```

Visit the printed URL, load a `.nes` file, and the UI will drive the real QuickNES libretro core directly in the browser.

## Programmatic usage

```js
import { LibretroHost } from "./web/libretro-host.js";
import { createWasiImports } from "./web/wasi.js";

const host = new LibretroHost({
  callbacks: {
    environment: (payload) => console.log(payload.cmd),
    videoRefresh: (frame, width, height, pitch) => draw(frame, width, height, pitch),
    audioSampleBatch: (samples, frames) => audio.enqueue(samples, frames),
    inputState: ({ id }) => (id === 0 ? 1 : 0),
  },
});

const wasi = createWasiImports();
await host.load(await fetchCoreBytes(), { imports: wasi.imports });
wasi.setMemory(host.memory);

host.initializeCore();
host.loadGame({ path: "game.nes", data: romBytes });
host.runFrame();
```

### How the shim works

Every core built from `cores/CMakeLists.txt` links against `libretro_shim.c`. The shim:

1. Imports six host functions from the `libretro_host` module (`environment`, `video_refresh`, `audio_sample`, `audio_sample_batch`, `input_poll`, `input_state`).
2. Registers its own static callbacks with the core’s `retro_set_*` entrypoints.
3. Defines its indirect function table internally, so no host-supplied table (and no `funcref`) is required.
4. Exports a helper `libretro_host_init` that the frontend calls immediately after instantiation.

Because of this, `LibretroHost` doesn’t fabricate tables or thunks: any WASM runtime (including ones that only support `anyfunc`, such as WAMR) can host the core as long as it provides the six shim imports and WASI.

### WASI runtime helper

`createWasiImports(options)` returns:

- `imports`: pass into `LibretroHost.load`.
- `setMemory(memory)`: call immediately after loading.
- `initialize(instance)`: optional convenience wrapper.

Options allow overriding `args`, `env`, `stdout`, `stderr`, and `randomFill`.

## Developing new cores

1. Add sources under `cores/` or a new directory and update `cores/CMakeLists.txt` like the existing `quicknes_core` target.
2. Link against `${LIBRETRO_SHIM_SOURCE}` to automatically get the host bridge.
3. Re-run `cmake --build build` (or `npm run cores`) to regenerate `build/cores/<name>.wasm`.
4. Point the browser demo (or your own frontend) at the new artifact.

## Cleaning up / legacy files

The `old/` tree holds the previous Makefile-based experiment and will be removed once everything has been ported to CMake. Nothing under `web/` relies on those files anymore.

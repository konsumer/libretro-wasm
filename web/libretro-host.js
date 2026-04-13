const PAGE_SIZE = 65536;
const RETRO_HW_FRAME_BUFFER_VALID = 0xffffffff >>> 0;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let nodeReadFile = null;

const readFileFromNode = async (wasmPath) => {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error("LibretroHost.fromFile is only available in Node.js environments");
  }
  if (!nodeReadFile) {
    ({ readFile: nodeReadFile } = await import("node:fs/promises"));
  }
  return nodeReadFile(wasmPath);
};

const defaultCallbacks = {
  environment: () => false,
  videoRefresh: () => {},
  audioSample: () => {},
  audioSampleBatch: () => 0,
  inputPoll: () => {},
  inputState: () => 0,
};

const mergeImports = (...sources) => {
  const merged = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [moduleName, moduleImports] of Object.entries(source)) {
      merged[moduleName] ??= {};
      Object.assign(merged[moduleName], moduleImports);
    }
  }
  return merged;
};

/**
 * Minimal libretro frontend for WebAssembly cores.
 */
export class LibretroHost {
  /**
   * @param {object} [options]
   * @param {object} [options.imports] - Import object merged when instantiating the core.
   * @param {object} [options.callbacks] - Partial override of callback handlers.
   */
  constructor(options = {}) {
    this.imports = options.imports ?? {};
    this.callbacks = { ...defaultCallbacks, ...(options.callbacks ?? {}) };
    this.wasiBridge = options.wasiBridge ?? null;

    this.instance = null;
    this.module = null;
    this.exports = null;
    this.memory = null;
    this._allocCursor = 0;
    this.systemInfo = null;
    this.mountedFiles = new Set();
  }

  /**
   * Convenience helper that instantiates a core from disk.
   * @param {string} wasmPath
   * @param {object} [options]
   */
  static async fromFile(wasmPath, options = {}) {
    const source = await readFileFromNode(wasmPath);
    const host = new LibretroHost(options);
    await host.load(source, options);
    return host;
  }

  /**
   * Instantiates a libretro core from any BufferSource.
   * @param {BufferSource | WebAssembly.Module} coreSource
   * @param {object} [options]
   * @param {object} [options.imports]
   */
  async load(coreSource, options = {}) {
    const shimImports = this._createLibretroHostImports();
    const mergedImports = mergeImports(this.imports, options.imports, shimImports);

    let module;
    if (coreSource instanceof WebAssembly.Module) {
      module = coreSource;
    } else {
      const normalized = this._normalizeBuffer(coreSource);
      module = await WebAssembly.compile(normalized);
    }

    const instance = await WebAssembly.instantiate(module, mergedImports);

    this.imports = mergedImports;
    this.module = module;
    this.instance = instance;
    this.exports = instance.exports;
    this.memory = this._resolveMemory();
    this._callConstructors();
    this._initAllocator();
    this._configureCallbackBridge();
    this._cacheSystemInfo();
  }

  /**
   * Updates callbacks at runtime.
   * @param {object} overrides
   */
  setCallbacks(overrides) {
    this.callbacks = { ...this.callbacks, ...overrides };
  }

  /**
   * Calls retro_init if exported.
   */
  initializeCore() {
    this._assertExports();
    if (typeof this.exports.retro_init === "function") {
      this.exports.retro_init();
    }
  }

  /**
   * Calls retro_deinit if exported.
   */
  shutdownCore() {
    if (this.exports && typeof this.exports.retro_deinit === "function") {
      this.exports.retro_deinit();
    }
  }

  /**
   * Loads a game into the core.
   * @param {{ path?: string, data?: Uint8Array|ArrayBufferView|ArrayBuffer, meta?: string }} [game]
   */
  loadGame(game = undefined) {
    this._assertExports();
    if (typeof this.exports.retro_load_game !== "function") {
      throw new Error("Core does not export retro_load_game");
    }

    if (!game) {
      this._unmountAllFiles();
      return Boolean(this.exports.retro_load_game(0));
    }

    this._unmountAllFiles();

    const pathPtr = game.path ? this._writeCString(game.path) : 0;
    const dataBytes = this._normalizeBuffer(game.data ?? new Uint8Array());
    const dataPtr = dataBytes.byteLength ? this._writeBytes(dataBytes) : 0;
    const size = dataBytes.byteLength >>> 0;
    const metaPtr = game.meta ? this._writeCString(game.meta) : 0;

    const structPtr = this._alloc(16, 4);
    this._writeU32(structPtr, pathPtr);
    this._writeU32(structPtr + 4, dataPtr);
    this._writeU32(structPtr + 8, size);
    this._writeU32(structPtr + 12, metaPtr);

    let mountedPath = null;
    if (game.path && dataBytes.byteLength && this.wasiBridge?.mountFile) {
      mountedPath = game.path;
      this._mountVirtualFile(mountedPath, dataBytes);
    }

    const success = Boolean(this.exports.retro_load_game(structPtr));
    if (!success && mountedPath) {
      this._unmountFile(mountedPath);
    }
    return success;
  }

  getSystemAvInfo() {
    this._assertExports();
    if (typeof this.exports.retro_get_system_av_info !== "function") {
      return null;
    }
    const structSize = 40;
    const ptr = this._alloc(structSize, 8);
    new Uint8Array(this.memory.buffer, ptr, structSize).fill(0);
    this.exports.retro_get_system_av_info(ptr);
    const view = new DataView(this.memory.buffer);
    const geometry = {
      baseWidth: view.getUint32(ptr, true),
      baseHeight: view.getUint32(ptr + 4, true),
      maxWidth: view.getUint32(ptr + 8, true),
      maxHeight: view.getUint32(ptr + 12, true),
      aspectRatio: view.getFloat32(ptr + 16, true),
    };
    const timingOffset = ptr + 24;
    const timing = {
      fps: view.getFloat64(timingOffset, true),
      sampleRate: view.getFloat64(timingOffset + 8, true),
    };
    return { geometry, timing };
  }

  /**
   * Calls retro_unload_game if exported.
   */
  unloadGame() {
    if (this.exports && typeof this.exports.retro_unload_game === "function") {
      this.exports.retro_unload_game();
    }
    this._unmountAllFiles();
  }

  /**
   * Executes a single frame (retro_run).
   */
  runFrame() {
    this._assertExports();
    if (typeof this.exports.retro_run !== "function") {
      throw new Error("Core does not export retro_run");
    }
    this.exports.retro_run();
  }

  /**
   * Reads a null-terminated UTF-8 string from the core memory.
   * @param {number} ptr
   */
  readCString(ptr) {
    if (!ptr) return "";
    const bytes = new Uint8Array(this.memory.buffer);
    let end = ptr;
    while (end < bytes.length && bytes[end] !== 0) {
      end += 1;
    }
    return textDecoder.decode(bytes.subarray(ptr, end));
  }

  /**
   * Allocates raw bytes inside the core memory.
   * @param {number} size
   * @param {number} [alignment=8]
   */
  _alloc(size, alignment = 8) {
    if (typeof this.exports.malloc === "function") {
      const ptr = this.exports.malloc(size);
      if (!ptr) throw new Error("Core malloc returned 0");
      return ptr >>> 0;
    }

    const alignedCursor = this._align(this._allocCursor, alignment);
    const next = alignedCursor + size;
    this._ensureCapacity(next);
    this._allocCursor = next;
    return alignedCursor >>> 0;
  }

  _align(value, alignment) {
    const mask = alignment - 1;
    return (value + mask) & ~mask;
  }

  _cacheSystemInfo() {
    if (this.systemInfo || typeof this.exports?.retro_get_system_info !== "function") {
      return;
    }
    const structSize = 24;
    const ptr = this._alloc(structSize, 4);
    new Uint8Array(this.memory.buffer, ptr, structSize).fill(0);
    this.exports.retro_get_system_info(ptr);
    const view = new DataView(this.memory.buffer);
    const info = {
      libraryName: this.readCString(view.getUint32(ptr, true)),
      libraryVersion: this.readCString(view.getUint32(ptr + 4, true)),
      validExtensions: this.readCString(view.getUint32(ptr + 8, true)),
      needFullpath: Boolean(new Uint8Array(this.memory.buffer, ptr + 12, 1)[0]),
      blockExtract: Boolean(new Uint8Array(this.memory.buffer, ptr + 13, 1)[0]),
    };
    this.systemInfo = info;
  }

  _mountVirtualFile(path, data) {
    if (!path || !data || !this.wasiBridge?.mountFile) {
      return;
    }
    this.wasiBridge.mountFile(path, data);
    this.mountedFiles.add(path);
  }

  _unmountFile(path) {
    if (!path || !this.mountedFiles.has(path)) {
      return;
    }
    if (this.wasiBridge?.unmountFile) {
      this.wasiBridge.unmountFile(path);
    }
    this.mountedFiles.delete(path);
  }

  _unmountAllFiles() {
    if (!this.mountedFiles.size) {
      return;
    }
    for (const path of this.mountedFiles) {
      if (this.wasiBridge?.unmountFile) {
        this.wasiBridge.unmountFile(path);
      }
    }
    this.mountedFiles.clear();
  }

  _writeBytes(bytes) {
    const buffer = this._normalizeBuffer(bytes);
    const ptr = this._alloc(buffer.byteLength || 1, 1);
    new Uint8Array(this.memory.buffer, ptr, buffer.byteLength).set(buffer);
    return ptr;
  }

  _writeCString(text) {
    const encoded = textEncoder.encode(text);
    const bytes = new Uint8Array(encoded.length + 1);
    bytes.set(encoded, 0);
    bytes[encoded.length] = 0;
    return this._writeBytes(bytes);
  }

  _writeU32(ptr, value) {
    new DataView(this.memory.buffer).setUint32(ptr, value >>> 0, true);
  }

  _normalizeBuffer(buffer) {
    if (!buffer) return new Uint8Array();
    if (buffer instanceof Uint8Array) return buffer;
    if (ArrayBuffer.isView(buffer)) {
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    throw new TypeError("Unsupported buffer type");
  }

  _resolveMemory() {
    const exported = this.instance.exports.memory;
    if (exported instanceof WebAssembly.Memory) {
      return exported;
    }
    const imported = this.imports.env?.memory;
    if (imported instanceof WebAssembly.Memory) {
      return imported;
    }
    throw new Error("Unable to locate linear memory for core");
  }

  _initAllocator() {
    if (typeof this.exports.__heap_base === "object" && this.exports.__heap_base instanceof WebAssembly.Global) {
      this._allocCursor = this.exports.__heap_base.value;
      return;
    }
    // Fallback to the end of the current memory buffer.
    this._allocCursor = this.memory.buffer.byteLength;
  }

  _ensureCapacity(bytesNeeded) {
    const currentPages = this.memory.buffer.byteLength / PAGE_SIZE;
    const requiredPages = Math.ceil(bytesNeeded / PAGE_SIZE);
    if (requiredPages > currentPages) {
      this.memory.grow(requiredPages - currentPages);
    }
  }

  _createLibretroHostImports() {
    return {
      libretro_host: {
        environment: (cmd, dataPtr) => (this._handleEnvironment(cmd >>> 0, dataPtr >>> 0) ? 1 : 0),
        video_refresh: (dataPtr, width, height, pitch) => {
          this._handleVideoRefresh(dataPtr >>> 0, width >>> 0, height >>> 0, pitch >>> 0);
        },
        audio_sample: (left, right) => {
          this._handleAudioSample(left | 0, right | 0);
        },
        audio_sample_batch: (dataPtr, frames) =>
          this._handleAudioSampleBatch(dataPtr >>> 0, frames >>> 0) | 0,
        input_poll: () => {
          this._handleInputPoll();
        },
        input_state: (port, device, index, id) =>
          this._handleInputState(port >>> 0, device >>> 0, index >>> 0, id >>> 0) | 0,
      },
    };
  }

  _configureCallbackBridge() {
    const connector = this.exports?.libretro_host_init;
    if (typeof connector !== "function") {
      throw new Error(
        "Core does not expose libretro_host_init; rebuild the core with the libretro_shim.c layer."
      );
    }
    connector();
  }

  _handleEnvironment(cmd, dataPtr) {
    const result = this.callbacks.environment?.({ cmd, dataPtr, host: this }) ?? false;
    return result ? 1 : 0;
  }

  _handleVideoRefresh(dataPtr, width, height, pitch) {
    const cb = this.callbacks.videoRefresh;
    if (!cb) return;
    if (!dataPtr) {
      cb(null, width, height, pitch, this);
      return;
    }
    if (dataPtr === RETRO_HW_FRAME_BUFFER_VALID) {
      cb("hw", width, height, pitch, this);
      return;
    }
    const frameSize = pitch * height;
    const view = new Uint8Array(this.memory.buffer, dataPtr, frameSize);
    cb(view, width, height, pitch, this);
  }

  _handleAudioSample(left, right) {
    this.callbacks.audioSample?.(left, right, this);
  }

  _handleAudioSampleBatch(dataPtr, frames) {
    const cb = this.callbacks.audioSampleBatch;
    if (!cb || !frames) return 0;
    const samples = new Int16Array(this.memory.buffer, dataPtr, frames * 2);
    const result = cb(samples, frames, this);
    return result | 0;
  }

  _handleInputPoll() {
    this.callbacks.inputPoll?.(this);
  }

  _handleInputState(port, device, index, id) {
    const value = this.callbacks.inputState?.({ port, device, index, id, host: this }) ?? 0;
    return value | 0;
  }

  _assertExports() {
    if (!this.exports) {
      throw new Error("Core not instantiated");
    }
  }

  _callConstructors() {
    const ctor = this.exports?.__wasm_call_ctors || this.exports?._initialize;
    if (typeof ctor === "function") {
      ctor();
    }
  }

}

export { RETRO_HW_FRAME_BUFFER_VALID };

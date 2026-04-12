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

const TABLE_ELEMENT_TYPE = (() => {
  try {
    // Some engines only accept "anyfunc" while newer ones prefer "funcref".
    new WebAssembly.Table({ element: "funcref", initial: 1 });
    return "funcref";
  } catch {
    return "anyfunc";
  }
})();

const DEFAULT_TABLE_MIN = 2048;

const CALLBACK_SIGNATURES = {
  retro_set_environment: { parameters: ["i32", "i32"], results: ["i32"] },
  retro_set_video_refresh: { parameters: ["i32", "i32", "i32", "i32"], results: [] },
  retro_set_audio_sample: { parameters: ["i32", "i32"], results: [] },
  retro_set_audio_sample_batch: { parameters: ["i32", "i32"], results: ["i32"] },
  retro_set_input_poll: { parameters: [], results: [] },
  retro_set_input_state: { parameters: ["i32", "i32", "i32", "i32"], results: ["i32"] },
};

const wasmTypeCodes = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
};

const thunkModuleCache = new Map();

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

    this.instance = null;
    this.module = null;
    this.exports = null;
    this.memory = null;
    this.table = null;
    this._allocCursor = 0;
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
    const mergedImports = mergeImports(this.imports, options.imports);

    let module;
    if (coreSource instanceof WebAssembly.Module) {
      module = coreSource;
    } else {
      const normalized = this._normalizeBuffer(coreSource);
      module = await WebAssembly.compile(normalized);
    }

    this._ensureTableImport(mergedImports, module);
    const instance = await WebAssembly.instantiate(module, mergedImports);

    this.imports = mergedImports;
    this.module = module;
    this.instance = instance;
    this.exports = instance.exports;
    this.memory = this._resolveMemory();
    this.table = this._resolveTable();
    this._callConstructors();
    this._initAllocator();
    this._registerLibretroCallbacks();
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
      return Boolean(this.exports.retro_load_game(0));
    }

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

    return Boolean(this.exports.retro_load_game(structPtr));
  }

  /**
   * Calls retro_unload_game if exported.
   */
  unloadGame() {
    if (this.exports && typeof this.exports.retro_unload_game === "function") {
      this.exports.retro_unload_game();
    }
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

  _resolveTable() {
    const exported = this.instance.exports.__indirect_function_table;
    if (exported instanceof WebAssembly.Table) {
      return exported;
    }
    const imported = this.imports.env?.__indirect_function_table;
    if (imported instanceof WebAssembly.Table) {
      return imported;
    }
    throw new Error("Unable to locate indirect function table");
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

  _ensureTableImport(imports, module) {
    imports.env ??= {};

    let table = imports.env.__indirect_function_table;
    if (table instanceof WebAssembly.Table) {
      return table;
    }

    if (!module || typeof WebAssembly.Module.imports !== "function") {
      return null;
    }

    const tableImport = WebAssembly.Module.imports(module).find(
      (entry) => entry.kind === "table" && (entry.name === "__indirect_function_table" || entry.field === "__indirect_function_table")
    );

    if (!tableImport) {
      return null;
    }

    const type = tableImport.type ?? {};
    const minRequired = Math.max(type.minimum ?? 0, DEFAULT_TABLE_MIN);
    const desc = {
      element: type.element ?? TABLE_ELEMENT_TYPE,
      initial: minRequired,
    };
    if (typeof type.maximum === "number") {
      desc.maximum = Math.max(type.maximum, minRequired);
    }

    table = new WebAssembly.Table(desc);
    imports.env.__indirect_function_table = table;
    return table;
  }

  _registerLibretroCallbacks() {
    if (!this.exports) return;

    const register = (name, handler) => {
      const setter = this.exports[name];
      if (typeof setter !== "function") return;
      const signature = CALLBACK_SIGNATURES[name] ?? null;
      const slot = this._addHostFunction(handler, signature);
      setter(slot >>> 0);
    };

    register("retro_set_environment", (cmd, dataPtr) => this._handleEnvironment(cmd >>> 0, dataPtr >>> 0));
    register("retro_set_video_refresh", (dataPtr, width, height, pitch) =>
      this._handleVideoRefresh(dataPtr >>> 0, width >>> 0, height >>> 0, pitch >>> 0)
    );
    register("retro_set_audio_sample", (left, right) => this._handleAudioSample(left | 0, right | 0));
    register("retro_set_audio_sample_batch", (dataPtr, frames) =>
      this._handleAudioSampleBatch(dataPtr >>> 0, frames >>> 0)
    );
    register("retro_set_input_poll", () => this._handleInputPoll());
    register("retro_set_input_state", (port, device, index, id) =>
      this._handleInputState(port >>> 0, device >>> 0, index >>> 0, id >>> 0)
    );
  }

  _addHostFunction(fn, signature = null) {
    if (!(this.table instanceof WebAssembly.Table)) {
      throw new Error("Function table is not available");
    }
    const slot = this.table.grow(1);
    const callable = this._wrapHostFunction(fn, signature);
    this.table.set(slot, callable);
    return slot;
  }

  _wrapHostFunction(fn, signature) {
    if (!signature) {
      return fn;
    }
    const wasmFn = createHostThunk(fn, signature);
    return wasmFn ?? fn;
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

function createHostThunk(fn, signature) {
  if (typeof WebAssembly.Function === "function") {
    try {
      return new WebAssembly.Function(signature, fn);
    } catch (error) {
      console.warn("WebAssembly.Function construction failed; falling back to thunk module", error);
    }
  }

  try {
    const module = getThunkModule(signature);
    const instance = new WebAssembly.Instance(module, { host: { fn } });
    return instance.exports.thunk;
  } catch (error) {
    console.error("Unable to fabricate WASM thunk for host callback", error);
    return null;
  }
}

function getThunkModule(signature) {
  const key = `${signature.parameters?.join(",") ?? ""}->${signature.results?.join(",") ?? ""}`;
  if (thunkModuleCache.has(key)) {
    return thunkModuleCache.get(key);
  }
  const bytes = buildThunkBinary(signature);
  const module = new WebAssembly.Module(bytes);
  thunkModuleCache.set(key, module);
  return module;
}

function buildThunkBinary(signature) {
  const params = signature.parameters ?? [];
  const results = signature.results ?? [];
  const bytes = [];

  const pushBytes = (array) => {
    bytes.push(...array);
  };

  const writeName = (name, target) => {
    const data = textEncoder.encode(name);
    writeU32(target, data.length);
    for (const byte of data) {
      target.push(byte);
    }
  };

  const pushSection = (id, payload) => {
    bytes.push(id);
    const size = [];
    writeU32(size, payload.length);
    bytes.push(...size, ...payload);
  };

  pushBytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  const typeEntry = [0x60];
  const paramVec = [];
  writeU32(paramVec, params.length);
  for (const param of params) {
    paramVec.push(wasmTypeCodes[param] ?? wasmTypeCodes.i32);
  }
  typeEntry.push(...paramVec);
  const resultVec = [];
  writeU32(resultVec, results.length);
  for (const result of results) {
    resultVec.push(wasmTypeCodes[result] ?? wasmTypeCodes.i32);
  }
  typeEntry.push(...resultVec);
  const typePayload = [];
  writeU32(typePayload, 1);
  typePayload.push(...typeEntry);
  pushSection(1, typePayload);

  const importEntry = [];
  writeName("host", importEntry);
  writeName("fn", importEntry);
  importEntry.push(0x00);
  writeU32(importEntry, 0);
  const importPayload = [];
  writeU32(importPayload, 1);
  importPayload.push(...importEntry);
  pushSection(2, importPayload);

  const funcPayload = [];
  writeU32(funcPayload, 1);
  writeU32(funcPayload, 0);
  pushSection(3, funcPayload);

  const exportEntry = [];
  writeName("thunk", exportEntry);
  exportEntry.push(0x00);
  writeU32(exportEntry, 1);
  const exportPayload = [];
  writeU32(exportPayload, 1);
  exportPayload.push(...exportEntry);
  pushSection(7, exportPayload);

  const instructions = [];
  params.forEach((_, index) => {
    instructions.push(0x20);
    writeU32(instructions, index);
  });
  instructions.push(0x10);
  writeU32(instructions, 0);
  instructions.push(0x0b);

  const body = [0x00, ...instructions];
  const codeEntry = [];
  writeU32(codeEntry, body.length);
  codeEntry.push(...body);
  const codePayload = [];
  writeU32(codePayload, 1);
  codePayload.push(...codeEntry);
  pushSection(10, codePayload);

  return new Uint8Array(bytes);
}

function writeU32(target, value) {
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    target.push(byte);
  } while (remaining);
}

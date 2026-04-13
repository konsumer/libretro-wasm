import { LibretroHost } from "./libretro-host.js";
import { createWasiImports } from "./wasi.js";

const RETRO_ENV = {
  SET_ROTATION: 1,
  GET_CAN_DUPE: 3,
  SET_SYSTEM_AV_INFO: 32,
  SET_PIXEL_FORMAT: 10,
  SET_INPUT_DESCRIPTORS: 11,
  GET_VARIABLE: 15,
  SET_VARIABLES: 16,
  GET_VARIABLE_UPDATE: 17,
  SET_SUPPORT_NO_GAME: 18,
  GET_SYSTEM_DIRECTORY: 9,
  SET_CONTROLLER_INFO: 35,
  SET_MEMORY_MAPS: 0x10000 | 36,
  GET_LANGUAGE: 39,
  GET_AUDIO_VIDEO_ENABLE: 0x10000 | 47,
  GET_INPUT_BITMASKS: 0x10000 | 51,
  GET_CORE_OPTIONS_VERSION: 52,
  SET_CORE_OPTIONS: 53,
  SET_CORE_OPTIONS_INTL: 54,
  SET_CORE_OPTIONS_DISPLAY: 55,
  SET_MESSAGE: 6,
  GET_MESSAGE_INTERFACE_VERSION: 59,
  SET_MESSAGE_EXT: 60,
  SET_VARIABLE: 70,
};

const RETRO_DEVICE = {
  NONE: 0,
  JOYPAD: 1,
};

const RETRO_JOYPAD = {
  B: 0,
  Y: 1,
  SELECT: 2,
  START: 3,
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  A: 8,
  X: 9,
  L: 10,
  R: 11,
};

const PIXEL_FORMAT = {
  RGB565: 2,
};

const AUDIO_PENDING_FLUSH_SAMPLES = 8192;

const CORE_LIBRARY = [
  {
    id: "quicknes",
    label: "QuickNES (NES)",
    path: "./cores/quicknes.wasm",
    romLabel: "Load NES ROM",
    extensions: [".nes"],
    description: "Nintendo Entertainment System",
  },
  {
    id: "gambatte",
    label: "Gambatte (GB/GBC)",
    path: "./cores/gambatte.wasm",
    romLabel: "Load GB/GBC ROM",
    extensions: [".gb", ".gbc"],
    description: "Game Boy / Game Boy Color",
  },
  {
    id: "stella2014",
    label: "Stella 2014 (Atari 2600)",
    path: "./cores/stella2014.wasm",
    romLabel: "Load Atari 2600 ROM",
    extensions: [".a26", ".bin", ".rom", ".zip"],
    description: "Atari 2600",
  },
];

const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d", { alpha: false });
const romNameEl = document.getElementById("romName");
const statusEl = document.getElementById("statusLine");
const fileInput = document.getElementById("romInput");
const resetBtn = document.getElementById("resetBtn");
const coreSelect = document.getElementById("coreSelect");
const romLabelEl = document.getElementById("romLabel");
const coreNameEl = document.getElementById("coreName");

fileInput.disabled = true;

let host = null;
let wasi = null;
let rafHandle = 0;
let gameLoaded = false;
let framebuffer = null;
let framebufferWidth = 0;
let framebufferHeight = 0;
let pendingSamples = [];
let currentCore = null;
let coreSwitchPromise = null;
let coreSampleRate = 44100;
let coreAspectRatio = 256 / 240;
let input = null;
let audio = null;
let env = null;

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file || !host) return;
  try {
    await audio.resume();
    await loadRom(file);
  } catch (error) {
    console.error(error);
    updateStatus(`Unable to load ROM: ${error.message}`);
  }
});

resetBtn.addEventListener("click", () => {
  if (!gameLoaded || !host?.exports?.retro_reset) return;
  host.exports.retro_reset();
  updateStatus("Core reset");
});

coreSelect.addEventListener("change", async (event) => {
  const coreId = event.target.value;
  try {
    await selectCore(coreId);
  } catch (error) {
    console.error(error);
    updateStatus(`Failed to load core: ${error.message}`);
  }
});

async function initialize() {
  populateCoreOptions();
  if (!CORE_LIBRARY.length) {
    updateStatus("No cores configured.");
    clearCoreMetadata();
    fileInput.disabled = true;
    coreSelect.disabled = true;
    resetBtn.disabled = true;
    return;
  }
  coreSelect.value = CORE_LIBRARY[0].id;
  await selectCore(CORE_LIBRARY[0].id);
}

function populateCoreOptions() {
  coreSelect.innerHTML = "";
  if (!CORE_LIBRARY.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No cores available";
    coreSelect.append(option);
    return;
  }
  for (const core of CORE_LIBRARY) {
    const option = document.createElement("option");
    option.value = core.id;
    option.textContent = core.label;
    coreSelect.append(option);
  }
}

async function selectCore(coreId) {
  if (!coreId) return;
  const config = CORE_LIBRARY.find((core) => core.id === coreId);
  if (!config) {
    throw new Error(`Unknown core '${coreId}'`);
  }
  if (coreSwitchPromise) {
    await coreSwitchPromise;
  }
  coreSwitchPromise = (async () => {
    coreSelect.disabled = true;
    fileInput.disabled = true;
    await teardownCurrentCore();
    applyCoreMetadata(config);
    try {
      await bootstrap(config);
      currentCore = config;
      fileInput.disabled = false;
    } catch (error) {
      clearCoreMetadata();
      throw error;
    } finally {
      coreSelect.disabled = false;
    }
  })();
  try {
    await coreSwitchPromise;
  } finally {
    coreSwitchPromise = null;
  }
}

function applyCoreMetadata(core) {
  romLabelEl.textContent = core.romLabel ?? "Load ROM";
  romInput.accept = (core.extensions ?? []).join(",");
  romInput.value = "";
  coreNameEl.textContent = core.label;
  romNameEl.textContent = "—";
}

function clearCoreMetadata() {
  romLabelEl.textContent = "Load ROM";
  romInput.accept = "";
  romInput.value = "";
  coreNameEl.textContent = "—";
  romNameEl.textContent = "—";
}

function teardownCurrentCore() {
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
  if (host?.unloadGame) {
    try {
      host.unloadGame();
    } catch (error) {
      console.warn("Failed to unload previous game", error);
    }
  }
  host = null;
  wasi = null;
  gameLoaded = false;
  pendingSamples = [];
  framebuffer = null;
  framebufferWidth = 0;
  framebufferHeight = 0;
  coreSampleRate = 44100;
  audio.setSourceSampleRate(coreSampleRate);
}

async function bootstrap(coreConfig) {
  updateStatus(`Fetching ${coreConfig.label}…`);
  const response = await fetch(coreConfig.path);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} when fetching core`);
  }
  const coreBytes = await response.arrayBuffer();

  env = createEnvironment();
  host = new LibretroHost({
    callbacks: {
      environment: (payload) => env.handle(payload),
      videoRefresh: handleVideoRefresh,
      audioSampleBatch: handleAudioBatch,
      audioSample: handleAudioSample,
      inputPoll: () => input.poll(),
      inputState: (query) => input.state(query),
    },
  });

  wasi = createWasiImports();
  await host.load(coreBytes, { imports: wasi.imports });
  wasi.setMemory(host.memory);
  host.initializeCore();
  synchronizeAvInfoFromCore();
  updateStatus(`${coreConfig.label} ready. Load a ROM to begin.`);
}

async function loadRom(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  if (gameLoaded) {
    host.unloadGame();
  }
  pendingSamples = [];
  const loaded = host.loadGame({ path: file.name, data });
  if (!loaded) {
    throw new Error("retro_load_game returned false");
  }
  synchronizeAvInfoFromCore();
  romNameEl.textContent = file.name;
  gameLoaded = true;
  updateStatus(`Running ${file.name} on ${currentCore?.label ?? "core"}`);
  startLoop();
}

function startLoop() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  const step = () => {
    try {
      if (gameLoaded) {
        host.runFrame();
      }
    } catch (error) {
      console.error(error);
      updateStatus(`Emulator error: ${error.message}`);
      gameLoaded = false;
      return;
    }
    rafHandle = requestAnimationFrame(step);
  };
  rafHandle = requestAnimationFrame(step);
}

function handleVideoRefresh(frame, width, height, pitch) {
  if (!frame || frame === "hw") return;
  if (!width || !height) return;
  ensureSurface(width, height);

  const stride = pitch >>> 1;
  const src = new Uint16Array(frame.buffer, frame.byteOffset, stride * height);
  const dst = framebuffer.data;
  let di = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const pixel = src[row + x];
      const r = ((pixel >> 11) & 0x1f) * 255 / 31;
      const g = ((pixel >> 5) & 0x3f) * 255 / 63;
      const b = (pixel & 0x1f) * 255 / 31;
      dst[di++] = r;
      dst[di++] = g;
      dst[di++] = b;
      dst[di++] = 255;
    }
  }

  ctx.putImageData(framebuffer, 0, 0);
}

function handleAudioBatch(samples, frames) {
  if (!frames || !samples) return 0;
  const copy = samples.slice(0, frames * 2);
  audio.push(copy, frames, coreSampleRate);
  return frames;
}

function handleAudioSample(left, right) {
  pendingSamples.push(left, right);
  if (pendingSamples.length >= AUDIO_PENDING_FLUSH_SAMPLES) {
    const buffer = Int16Array.from(pendingSamples);
    pendingSamples = [];
    audio.push(buffer, buffer.length / 2, coreSampleRate);
  }
}

function ensureSurface(width, height) {
  if (width === framebufferWidth && height === framebufferHeight && framebuffer) return;
  framebufferWidth = width;
  framebufferHeight = height;
  canvas.width = width;
  canvas.height = height;
  framebuffer = ctx.createImageData(width, height);
}

function updateStatus(text) {
  statusEl.textContent = text;
}

class RetroEnvironment {
  constructor(onMessage, options = {}) {
    this.onMessage = onMessage;
    this.onAvInfoChange = options.onAvInfoChange ?? null;
    this.variables = new Map();
    this.variablePointers = new Map();
    this.variableDirty = false;
    this.pixelFormat = 0;
    this.avInfo = this._defaultAvInfo();
  }

  handle({ cmd, dataPtr, host }) {
    const view = new DataView(host.memory.buffer);
    switch (cmd) {
      case RETRO_ENV.SET_PIXEL_FORMAT:
        this.pixelFormat = view.getUint32(dataPtr, true);
        return this.pixelFormat === PIXEL_FORMAT.RGB565;
      case RETRO_ENV.SET_SYSTEM_AV_INFO:
        return this._applySystemAvInfo(host, view, dataPtr);
      case RETRO_ENV.SET_INPUT_DESCRIPTORS:
      case RETRO_ENV.SET_CONTROLLER_INFO:
      case RETRO_ENV.SET_MEMORY_MAPS:
      case RETRO_ENV.SET_SUPPORT_NO_GAME:
      case RETRO_ENV.SET_ROTATION:
        return true;
      case RETRO_ENV.GET_CAN_DUPE:
        if (dataPtr) view.setUint8(dataPtr, 1);
        return true;
      case RETRO_ENV.GET_VARIABLE:
        return this._writeVariable(host, view, dataPtr);
      case RETRO_ENV.SET_VARIABLES:
        this._ingestVariables(host, view, dataPtr);
        return true;
      case RETRO_ENV.SET_VARIABLE:
        if (!dataPtr) return true;
        return this._updateVariableFromCore(host, view, dataPtr);
      case RETRO_ENV.GET_VARIABLE_UPDATE:
        if (dataPtr) {
          view.setUint8(dataPtr, this.variableDirty ? 1 : 0);
        }
        this.variableDirty = false;
        return true;
      case RETRO_ENV.GET_LANGUAGE:
        if (dataPtr) view.setUint32(dataPtr, 0, true);
        return true;
      case RETRO_ENV.GET_AUDIO_VIDEO_ENABLE:
        if (dataPtr) view.setUint32(dataPtr, 1 | 2, true);
        return true;
      case RETRO_ENV.GET_INPUT_BITMASKS:
        return false;
      case RETRO_ENV.GET_CORE_OPTIONS_VERSION:
        return false;
      case RETRO_ENV.SET_MESSAGE:
        this._handleMessage(host, view, dataPtr);
        return true;
      case RETRO_ENV.SET_MESSAGE_EXT:
        this._handleMessageExt(host, view, dataPtr);
        return true;
      case RETRO_ENV.GET_MESSAGE_INTERFACE_VERSION:
        return false;
      default:
        return false;
    }
  }

  setAvInfo(info) {
    if (!info) return;
    this.avInfo = this._normalizeAvInfo(info);
    this.onAvInfoChange?.(this.avInfo);
  }

  _applySystemAvInfo(host, view, ptr) {
    if (!ptr) return false;
    const info = this._readSystemAvInfo(host, view, ptr);
    if (!info) return false;
    this.setAvInfo(info);
    return true;
  }

  _readSystemAvInfo(host, view, ptr) {
    const dv = this._ensureView(host, view);
    if (!dv) return null;
    const geometry = {
      baseWidth: dv.getUint32(ptr, true),
      baseHeight: dv.getUint32(ptr + 4, true),
      maxWidth: dv.getUint32(ptr + 8, true),
      maxHeight: dv.getUint32(ptr + 12, true),
      aspectRatio: dv.getFloat32(ptr + 16, true),
    };
    const timingOffset = ptr + 24;
    const timing = {
      fps: dv.getFloat64(timingOffset, true),
      sampleRate: dv.getFloat64(timingOffset + 8, true),
    };
    return this._normalizeAvInfo({ geometry, timing });
  }

  _ensureView(host, view) {
    if (host?.memory) {
      if (!view || view.buffer !== host.memory.buffer) {
        return new DataView(host.memory.buffer);
      }
    }
    return view ?? null;
  }

  _defaultAvInfo() {
    return {
      geometry: {
        baseWidth: 256,
        baseHeight: 240,
        maxWidth: 256,
        maxHeight: 240,
        aspectRatio: 256 / 240,
      },
      timing: {
        fps: 60,
        sampleRate: 44100,
      },
    };
  }

  _normalizeAvInfo(info) {
    const defaults = this._defaultAvInfo();
    const geometry = info?.geometry ?? {};
    const timing = info?.timing ?? {};
    return {
      geometry: {
        baseWidth: geometry.baseWidth ?? defaults.geometry.baseWidth,
        baseHeight: geometry.baseHeight ?? defaults.geometry.baseHeight,
        maxWidth: geometry.maxWidth ?? defaults.geometry.maxWidth,
        maxHeight: geometry.maxHeight ?? defaults.geometry.maxHeight,
        aspectRatio: geometry.aspectRatio ?? defaults.geometry.aspectRatio,
      },
      timing: {
        fps: timing.fps ?? defaults.timing.fps,
        sampleRate: timing.sampleRate ?? defaults.timing.sampleRate,
      },
    };
  }

  _ingestVariables(host, view, ptr) {
    this.variables.clear();
    this.variablePointers.clear();
    this.variableDirty = true;

    let cursor = ptr;
    while (true) {
      const keyPtr = view.getUint32(cursor, true);
      if (!keyPtr) break;
      const valuePtr = view.getUint32(cursor + 4, true);
      const key = host.readCString(keyPtr);
      const definition = valuePtr ? host.readCString(valuePtr) : "";
      const record = this._parseOption(definition);
      this.variables.set(key, record);
      cursor += 8;
    }
  }

  _parseOption(definition) {
    if (!definition) {
      return { value: "", options: [] };
    }
    const separator = definition.indexOf(";");
    const valuesSegment = separator >= 0 ? definition.slice(separator + 1).trim() : definition;
    const options = valuesSegment
      .split("|")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const value = options[0] ?? "";
    return { value, options };
  }

  _writeVariable(host, view, ptr) {
    const keyPtr = view.getUint32(ptr, true);
    if (!keyPtr) return false;
    const valueOutPtr = ptr + 4;
    const key = host.readCString(keyPtr);
    const record = this.variables.get(key);
    if (!record) {
      view.setUint32(valueOutPtr, 0, true);
      return false;
    }
    const pointer = this._ensureValuePointer(host, key, record.value);
    const targetView = this._ensureView(host, view);
    if (!targetView) return false;
    targetView.setUint32(valueOutPtr, pointer >>> 0, true);
    return true;
  }

  _ensureValuePointer(host, key, value) {
    if (this.variablePointers.has(key)) {
      const cached = this.variablePointers.get(key);
      if (cached.value === value) {
        return cached.ptr;
      }
    }
    const ptr = host._writeCString(value);
    this.variablePointers.set(key, { ptr, value });
    return ptr;
  }

  _updateVariableFromCore(host, view, ptr) {
    const keyPtr = view.getUint32(ptr, true);
    const valuePtr = view.getUint32(ptr + 4, true);
    if (!keyPtr || !valuePtr) return false;
    const key = host.readCString(keyPtr);
    const value = host.readCString(valuePtr);
    const record = this.variables.get(key);
    if (!record) return false;
    record.value = value;
    this.variableDirty = true;
    this.variablePointers.delete(key);
    return true;
  }

  _handleMessage(host, view, ptr) {
    const msgPtr = view.getUint32(ptr, true);
    if (!msgPtr) return;
    const frames = view.getUint32(ptr + 4, true);
    const text = host.readCString(msgPtr);
    const millis = frames ? Math.round((frames / 60) * 1000) : 0;
    this.onMessage?.(text, millis);
  }

  _handleMessageExt(host, view, ptr) {
    const msgPtr = view.getUint32(ptr, true);
    if (!msgPtr) return;
    const durationMs = view.getUint32(ptr + 4, true);
    const text = host.readCString(msgPtr);
    this.onMessage?.(text, durationMs);
  }
}

class InputManager {
  constructor() {
    this.active = new Set();
    this.bindings = new Map([
      ["ArrowUp", RETRO_JOYPAD.UP],
      ["ArrowDown", RETRO_JOYPAD.DOWN],
      ["ArrowLeft", RETRO_JOYPAD.LEFT],
      ["ArrowRight", RETRO_JOYPAD.RIGHT],
      ["KeyZ", RETRO_JOYPAD.B],
      ["KeyX", RETRO_JOYPAD.A],
      ["KeyA", RETRO_JOYPAD.Y],
      ["KeyS", RETRO_JOYPAD.X],
      ["Enter", RETRO_JOYPAD.START],
      ["ShiftRight", RETRO_JOYPAD.SELECT],
      ["Space", RETRO_JOYPAD.SELECT],
      ["KeyQ", RETRO_JOYPAD.L],
      ["KeyW", RETRO_JOYPAD.R],
    ]);

    window.addEventListener("keydown", (event) => {
      if (this.bindings.has(event.code)) {
        event.preventDefault();
        this.active.add(event.code);
      }
    });

    window.addEventListener("keyup", (event) => {
      if (this.bindings.has(event.code)) {
        event.preventDefault();
        this.active.delete(event.code);
      }
    });
  }

  poll() {
    // No-op for now; keyboard state is event-driven
  }

  state({ port, device, id }) {
    if (port !== 0 || device !== RETRO_DEVICE.JOYPAD) return 0;
    for (const code of this.active) {
      if (this.bindings.get(code) === id) return 1;
    }
    return 0;
  }
}

class AudioSink {
  constructor() {
    this.context = null;
    this.nextTime = 0;
    this.minLeadSeconds = 0.04;
    this.sourceSampleRate = 44100;
  }

  async resume() {
    const ctx = this._ensureContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    this.nextTime = Math.max(this.nextTime, ctx.currentTime + this.minLeadSeconds);
  }

  setLeadSeconds(seconds) {
    if (Number.isFinite(seconds) && seconds > 0) {
      this.minLeadSeconds = seconds;
      if (this.context) {
        this.nextTime = Math.max(this.context.currentTime + this.minLeadSeconds, this.nextTime);
      }
    }
  }

  setSourceSampleRate(rate) {
    if (Number.isFinite(rate) && rate > 0) {
      this.sourceSampleRate = rate;
    }
  }

  push(samples, frames, sourceRate) {
    if (!frames || !samples) return;
    if (Number.isFinite(sourceRate) && sourceRate > 0) {
      this.sourceSampleRate = sourceRate;
    }
    const ctx = this._ensureContext();
    const targetRate = ctx.sampleRate;
    const sourceRateValue = this.sourceSampleRate || targetRate;
    const needsResample = Math.abs(sourceRateValue - targetRate) > 0.5;
    const outputFrames = needsResample
      ? Math.max(1, Math.round(frames * (targetRate / sourceRateValue)))
      : frames;
    const buffer = ctx.createBuffer(2, outputFrames, targetRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    if (needsResample) {
      this._resampleInto(samples, frames, left, right, sourceRateValue, targetRate);
    } else {
      this._copyInto(samples, frames, left, right);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(this.nextTime, ctx.currentTime + this.minLeadSeconds);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
  }

  _ensureContext() {
    if (!this.context) {
      const desiredRate = Math.max(8000, Math.min(192000, Math.floor(this.sourceSampleRate || 44100)));
      try {
        this.context = new AudioContext({ sampleRate: desiredRate });
      } catch (_error) {
        this.context = new AudioContext();
      }
      this.nextTime = this.context.currentTime;
    }
    return this.context;
  }

  _copyInto(samples, frames, left, right) {
    const scale = 1 / 32768;
    for (let i = 0; i < frames; i += 1) {
      const base = i * 2;
      left[i] = clampSample(samples[base] * scale);
      right[i] = clampSample(samples[base + 1] * scale);
    }
  }

  _resampleInto(samples, frames, left, right, sourceRate, targetRate) {
    if (frames <= 0) return;
    const scale = 1 / 32768;
    const step = sourceRate / targetRate;
    const lastFrame = frames - 1;
    for (let i = 0; i < left.length; i += 1) {
      const position = i * step;
      const base = Math.min(Math.floor(position), lastFrame);
      const frac = position - base;
      const next = Math.min(base + 1, lastFrame);
      const baseIndex = base * 2;
      const nextIndex = next * 2;
      const l0 = samples[baseIndex] * scale;
      const l1 = samples[nextIndex] * scale;
      const r0 = samples[baseIndex + 1] * scale;
      const r1 = samples[nextIndex + 1] * scale;
      left[i] = clampSample(l0 + (l1 - l0) * frac);
      right[i] = clampSample(r0 + (r1 - r0) * frac);
    }
  }
}

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

function applyCanvasAspectRatio() {
  if (!Number.isFinite(coreAspectRatio) || coreAspectRatio <= 0) return;
  canvas?.style.setProperty("aspect-ratio", `${coreAspectRatio}`);
}

function handleAvInfoChange(info) {
  if (!info?.timing) return;
  const nextSampleRate = info.timing.sampleRate;
  if (Number.isFinite(nextSampleRate) && nextSampleRate > 0) {
    coreSampleRate = nextSampleRate;
    audio?.setSourceSampleRate(coreSampleRate);
    pendingSamples = [];
  }
  const nextAspect = info.geometry?.aspectRatio;
  if (Number.isFinite(nextAspect) && nextAspect > 0) {
    coreAspectRatio = nextAspect;
    applyCanvasAspectRatio();
  }
  const nextLead = info.timing?.fps ? Math.min(0.08, Math.max(0.02, 2 / info.timing.fps)) : 0.04;
  audio?.setLeadSeconds(nextLead);
}

function createEnvironment() {
  return new RetroEnvironment(updateStatus, {
    onAvInfoChange: handleAvInfoChange,
  });
}

function synchronizeAvInfoFromCore() {
  if (!host?.getSystemAvInfo || !env?.setAvInfo) return;
  try {
    const info = host.getSystemAvInfo();
    if (info) {
      env.setAvInfo(info);
    }
  } catch (error) {
    console.warn("Unable to read system AV info", error);
  }
}

input = new InputManager();
audio = new AudioSink();
audio.setSourceSampleRate(coreSampleRate);
env = createEnvironment();
applyCanvasAspectRatio();

initialize().catch((error) => {
  console.error(error);
  updateStatus(`Failed to initialize core: ${error.message}`);
});

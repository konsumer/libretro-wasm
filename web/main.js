import { LibretroHost } from "./libretro-host.js";
import { createWasiImports } from "./wasi.js";

const RETRO_ENV = {
  SET_ROTATION: 1,
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

const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d", { alpha: false });
const romNameEl = document.getElementById("romName");
const statusEl = document.getElementById("statusLine");
const fileInput = document.getElementById("romInput");
const resetBtn = document.getElementById("resetBtn");

let host = null;
let wasi = null;
let rafHandle = 0;
let gameLoaded = false;
let framebuffer = null;
let framebufferWidth = 0;
let framebufferHeight = 0;
let pendingSamples = [];

bootstrap().catch((error) => {
  console.error(error);
  updateStatus(`Failed to initialize core: ${error.message}`);
});

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

async function bootstrap() {
  updateStatus("Fetching QuickNES core…");
  const response = await fetch("./cores/quicknes.wasm");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} when fetching core`);
  }
  const coreBytes = await response.arrayBuffer();

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
  updateStatus("Core ready. Load a ROM to begin.");
}

async function loadRom(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  if (gameLoaded) {
    host.unloadGame();
  }
  const loaded = host.loadGame({ path: file.name, data });
  if (!loaded) {
    throw new Error("retro_load_game returned false");
  }
  romNameEl.textContent = file.name;
  gameLoaded = true;
  updateStatus("Running");
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
  audio.push(copy, frames);
  return frames;
}

function handleAudioSample(left, right) {
  pendingSamples.push(left, right);
  if (pendingSamples.length >= 2048) {
    const buffer = Int16Array.from(pendingSamples);
    pendingSamples = [];
    audio.push(buffer, buffer.length / 2);
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
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.variables = new Map();
    this.variablePointers = new Map();
    this.variableDirty = false;
    this.pixelFormat = 0;
  }

  handle({ cmd, dataPtr, host }) {
    const view = new DataView(host.memory.buffer);
    switch (cmd) {
      case RETRO_ENV.SET_PIXEL_FORMAT:
        this.pixelFormat = view.getUint32(dataPtr, true);
        return this.pixelFormat === PIXEL_FORMAT.RGB565;
      case RETRO_ENV.SET_INPUT_DESCRIPTORS:
      case RETRO_ENV.SET_CONTROLLER_INFO:
      case RETRO_ENV.SET_MEMORY_MAPS:
      case RETRO_ENV.SET_SUPPORT_NO_GAME:
      case RETRO_ENV.SET_ROTATION:
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
    view.setUint32(valueOutPtr, pointer >>> 0, true);
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
  }

  async resume() {
    const ctx = this._ensureContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  }

  push(samples, frames) {
    if (!frames) return;
    const ctx = this._ensureContext();
    const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i += 1) {
      left[i] = clampSample(samples[i * 2] / 32768);
      right[i] = clampSample(samples[i * 2 + 1] / 32768);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(this.nextTime, ctx.currentTime + 0.01);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
  }

  _ensureContext() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 44100 });
      this.nextTime = this.context.currentTime;
    }
    return this.context;
  }
}

const env = new RetroEnvironment(updateStatus);
const input = new InputManager();
const audio = new AudioSink();

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

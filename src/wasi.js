const ERRNO = {
  SUCCESS: 0,
  BADF: 8,
  INVAL: 28,
  NOSYS: 52,
  PERM: 63,
};

const FILETYPE_CHARACTER_DEVICE = 2;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class WasiExit extends Error {
  constructor(code) {
    super(`WASI proc_exit: ${code}`);
    this.code = code >>> 0;
  }
}

const defaultRandom = (() => {
  if (globalThis.crypto?.getRandomValues) {
    return (buffer) => globalThis.crypto.getRandomValues(buffer);
  }
  return (buffer) => {
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = (Math.random() * 256) >>> 0;
    }
  };
})();

const nowMs = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

class WasiPreview1 {
  constructor(options = {}) {
    this.args = (options.args ?? []).map((value) => `${value}`);
    this.env = options.env ?? {};
    this.stdout = options.stdout ?? ((text) => console.log(text));
    this.stderr = options.stderr ?? ((text) => console.error(text));
    this.randomFill = options.randomFill ?? defaultRandom;

    this.memory = null;
    this.view = null;
    this.u8 = null;

    this.argsData = this._encodeList(this.args);
    const envPairs = Object.entries(this.env).map(([key, value]) => `${key}=${value}`);
    this.envData = this._encodeList(envPairs);

    this.exports = Object.freeze({
      args_get: this.args_get.bind(this),
      args_sizes_get: this.args_sizes_get.bind(this),
      environ_get: this.environ_get.bind(this),
      environ_sizes_get: this.environ_sizes_get.bind(this),
      clock_time_get: this.clock_time_get.bind(this),
      fd_close: this.fd_close.bind(this),
      fd_fdstat_get: this.fd_fdstat_get.bind(this),
      fd_prestat_get: this.fd_prestat_get.bind(this),
      fd_prestat_dir_name: this.fd_prestat_dir_name.bind(this),
      fd_read: this.fd_read.bind(this),
      fd_seek: this.fd_seek.bind(this),
      fd_tell: this.fd_tell.bind(this),
      fd_write: this.fd_write.bind(this),
      fd_sync: this.stub_nosys.bind(this),
      fd_datasync: this.stub_nosys.bind(this),
      fd_advise: this.stub_nosys.bind(this),
      fd_filestat_get: this.stub_badf.bind(this),
      fd_filestat_set_size: this.stub_badf.bind(this),
      fd_filestat_set_times: this.stub_badf.bind(this),
      fd_stat_set_flags: this.stub_nosys.bind(this),
      path_open: this.path_open.bind(this),
      path_filestat_get: this.stub_badf.bind(this),
      path_filestat_set_times: this.stub_badf.bind(this),
      path_remove_directory: this.stub_perm.bind(this),
      path_unlink_file: this.stub_perm.bind(this),
      poll_oneoff: this.stub_nosys.bind(this),
      proc_exit: this.proc_exit.bind(this),
      random_get: this.random_get.bind(this),
      sched_yield: this.stub_success.bind(this),
    });
  }

  setMemory(memory) {
    this.memory = memory;
    this._refreshViews();
  }

  args_get(argvPtr, argvBufPtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    return this._writePointerArray(this.argsData, argvPtr, argvBufPtr);
  }

  args_sizes_get(argcPtr, argvBufSizePtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    return this._writeListSize(this.argsData, argcPtr, argvBufSizePtr);
  }

  environ_get(envPtr, envBufPtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    return this._writePointerArray(this.envData, envPtr, envBufPtr);
  }

  environ_sizes_get(envCountPtr, envBufSizePtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    return this._writeListSize(this.envData, envCountPtr, envBufSizePtr);
  }

  fd_close() {
    return ERRNO.SUCCESS;
  }

  fd_fdstat_get(fd, statPtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    if (fd !== 0 && fd !== 1 && fd !== 2) return ERRNO.BADF;
    this.u8.subarray(statPtr, statPtr + 24).fill(0);
    this.view.setUint8(statPtr, FILETYPE_CHARACTER_DEVICE);
    return ERRNO.SUCCESS;
  }

  fd_prestat_get() {
    return ERRNO.BADF;
  }

  fd_prestat_dir_name() {
    return ERRNO.BADF;
  }

  fd_read(fd) {
    return fd <= 2 ? ERRNO.BADF : ERRNO.BADF;
  }

  fd_seek() {
    return ERRNO.BADF;
  }

  fd_tell() {
    return ERRNO.BADF;
  }

  fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    if (fd !== 1 && fd !== 2) return ERRNO.BADF;

    let bytesWritten = 0;
    for (let i = 0; i < iovsLen; i += 1) {
      const ptr = this.view.getUint32(iovsPtr + i * 8, true);
      const len = this.view.getUint32(iovsPtr + i * 8 + 4, true);
      const chunk = this.u8.subarray(ptr, ptr + len);
      const text = textDecoder.decode(chunk);
      if (text.length) {
        if (fd === 1) {
          this.stdout(text);
        } else {
          this.stderr(text);
        }
      }
      bytesWritten += len;
    }

    if (nwrittenPtr) {
      this.view.setUint32(nwrittenPtr, bytesWritten >>> 0, true);
    }
    return ERRNO.SUCCESS;
  }

  clock_time_get(clockId, _precision, timePtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    const ms = clockId === 0 ? Date.now() : nowMs();
    const nanos = BigInt(Math.floor(ms * 1e6));
    this._writeU64(timePtr, nanos);
    return ERRNO.SUCCESS;
  }

  path_open() {
    return ERRNO.PERM;
  }

  random_get(ptr, len) {
    if (!this._refreshViews()) return ERRNO.BADF;
    const view = this.u8.subarray(ptr, ptr + len);
    this.randomFill(view);
    return ERRNO.SUCCESS;
  }

  proc_exit(code) {
    throw new WasiExit(code >>> 0);
  }

  sched_yield() {
    return ERRNO.SUCCESS;
  }

  stub_nosys() {
    return ERRNO.NOSYS;
  }

  stub_badf() {
    return ERRNO.BADF;
  }

  stub_perm() {
    return ERRNO.PERM;
  }

  stub_success() {
    return ERRNO.SUCCESS;
  }

  _writePointerArray(list, basePtr, bufPtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    let offset = 0;
    list.buffers.forEach((buf, index) => {
      this.u8.subarray(bufPtr + offset, bufPtr + offset + buf.length).set(buf);
      this.view.setUint32(basePtr + index * 4, bufPtr + offset, true);
      offset += buf.length;
    });
    return ERRNO.SUCCESS;
  }

  _writeListSize(list, countPtr, sizePtr) {
    if (!this._refreshViews()) return ERRNO.BADF;
    this.view.setUint32(countPtr, list.buffers.length >>> 0, true);
    this.view.setUint32(sizePtr, list.totalBytes >>> 0, true);
    return ERRNO.SUCCESS;
  }

  _writeU64(ptr, value) {
    if (!this._refreshViews()) return;
    const lo = Number(value & 0xffffffffn);
    const hi = Number((value >> 32n) & 0xffffffffn);
    this.view.setUint32(ptr, lo >>> 0, true);
    this.view.setUint32(ptr + 4, hi >>> 0, true);
  }

  _encodeList(items) {
    const buffers = items.map((item) => {
      const encoded = textEncoder.encode(item);
      const buffer = new Uint8Array(encoded.length + 1);
      buffer.set(encoded, 0);
      buffer[encoded.length] = 0;
      return buffer;
    });
    const totalBytes = buffers.reduce((acc, buf) => acc + buf.length, 0);
    return { buffers, totalBytes };
  }

  _refreshViews() {
    if (!this.memory) {
      this.view = null;
      this.u8 = null;
      return false;
    }
    const buffer = this.memory.buffer;
    if (!this.view || this.view.buffer !== buffer) {
      this.view = new DataView(buffer);
      this.u8 = new Uint8Array(buffer);
    }
    return true;
  }
}

export function createWasiImports(options = {}) {
  const runtime = new WasiPreview1(options);
  return {
    imports: {
      wasi_snapshot_preview1: runtime.exports,
    },
    setMemory(memory) {
      runtime.setMemory(memory);
    },
    initialize(instance) {
      if (!instance || !instance.exports) return;
      const memory = instance.exports.memory;
      if (memory instanceof WebAssembly.Memory) {
        runtime.setMemory(memory);
      }
    },
  };
}

export { WasiExit };

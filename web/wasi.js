import WasiPreview1 from "@easywasm/wasi";

const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;

class InMemoryFS {
  constructor() {
    this.files = new Map();
    this.directories = new Map();
    this.children = new Map();
    this.inoCounter = 10;
    this._ensureDirectory("/");
  }

  mount(path, data) {
    const normalized = this._normalize(path);
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data ?? 0);
    const now = Date.now();
    this.files.set(normalized, {
      data: bytes,
      ino: this.inoCounter++,
      size: bytes.length,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
    });
    this._ensureParents(normalized);
  }

  unmount(path) {
    const normalized = this._normalize(path);
    if (!this.files.delete(normalized)) return;
    const parent = this._parent(normalized);
    this.children.get(parent)?.delete(normalized);
  }

  statSync(path) {
    const normalized = this._normalize(path);
    if (this.files.has(normalized)) {
      const file = this.files.get(normalized);
      return this._createStat(FILETYPE_REGULAR_FILE, file);
    }
    if (this.directories.has(normalized)) {
      const dir = this.directories.get(normalized);
      return this._createStat(FILETYPE_DIRECTORY, dir);
    }
    const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
    error.code = "ENOENT";
    throw error;
  }

  readFileSync(path) {
    const normalized = this._normalize(path);
    const file = this.files.get(normalized);
    if (!file) {
      const error = new Error(`ENOENT: no such file, open '${path}'`);
      error.code = "ENOENT";
      throw error;
    }
    return file.data;
  }

  readdirSync(path, options = {}) {
    const normalized = this._normalize(path);
    if (!this.directories.has(normalized)) {
      const error = new Error(`ENOTDIR: not a directory, scandir '${path}'`);
      error.code = "ENOTDIR";
      throw error;
    }
    const entries = Array.from(this.children.get(normalized) ?? []);
    if (options.withFileTypes) {
      return entries.map((childPath) => this._createDirent(childPath));
    }
    return entries.map((childPath) => this._basename(childPath));
  }

  // Unused mutating APIs throw to highlight unsupported operations.
  appendFileSync() { throw new Error("appendFileSync not implemented"); }
  fsyncSync() { throw new Error("fsyncSync not implemented"); }
  linkSync() { throw new Error("linkSync not implemented"); }
  mkdirSync() { throw new Error("mkdirSync not implemented"); }
  readlinkSync() { throw new Error("readlinkSync not implemented"); }
  renameSync() { throw new Error("renameSync not implemented"); }
  rmdirSync() { throw new Error("rmdirSync not implemented"); }
  setFlagsSync() { throw new Error("setFlagsSync not implemented"); }
  symlinkSync() { throw new Error("symlinkSync not implemented"); }
  truncateSync() { throw new Error("truncateSync not implemented"); }
  unlinkSync() { throw new Error("unlinkSync not implemented"); }
  utimesSync() { throw new Error("utimesSync not implemented"); }
  writeFileSync() { throw new Error("writeFileSync not implemented"); }

  _createStat(type, meta) {
    const isFile = type === FILETYPE_REGULAR_FILE;
    const isDirectory = type === FILETYPE_DIRECTORY;
    const stats = {
      dev: 1,
      ino: meta.ino,
      filetype: type,
      nlink: 1,
      size: meta.size ?? 0,
      atimeMs: meta.atimeMs ?? Date.now(),
      mtimeMs: meta.mtimeMs ?? Date.now(),
      ctimeMs: meta.ctimeMs ?? Date.now(),
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      isSymbolicLink: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
      isFIFO: () => false,
    };
    return stats;
  }

  _createDirent(fullPath) {
    const normalized = this._normalize(fullPath);
    const isFile = this.files.has(normalized);
    const isDirectory = this.directories.has(normalized);
    return {
      name: this._basename(normalized),
      isFile: () => isFile,
      isDirectory: () => isDirectory,
    };
  }

  _ensureParents(path) {
    let current = this._parent(path);
    while (current && !this.directories.has(current)) {
      this._ensureDirectory(current);
      current = this._parent(current);
    }
    const parent = this._parent(path);
    if (parent) {
      this.children.get(parent)?.add(path);
    }
  }

  _ensureDirectory(path) {
    const normalized = this._normalize(path);
    if (this.directories.has(normalized)) return;
    const now = Date.now();
    this.directories.set(normalized, {
      ino: this.inoCounter++,
      size: 0,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
    });
    if (!this.children.has(normalized)) {
      this.children.set(normalized, new Set());
    }
    const parent = this._parent(normalized);
    if (parent && parent !== normalized) {
      this._ensureDirectory(parent);
      this.children.get(parent)?.add(normalized);
    }
  }

  _normalize(path) {
    if (!path) return "/";
    let normalized = path.replace(/\\+/g, "/").replace(/\/+/g, "/");
    if (!normalized.startsWith("/")) {
      normalized = `/${normalized}`;
    }
    normalized = normalized.replace(/\/+/g, "/");
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized || "/";
  }

  _parent(path) {
    if (!path || path === "/") return "/";
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 1) return "/";
    return `/${parts.slice(0, -1).join("/")}`;
  }

  _basename(path) {
    if (!path || path === "/") return "";
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }
}

export function createWasiImports() {
  const fs = new InMemoryFS();
  const wasi = new WasiPreview1({ fs });

  return {
    imports: {
      wasi_snapshot_preview1: wasi,
    },
    initialize(instance) {
      if (instance?.exports) {
        wasi.setup(instance.exports);
      }
    },
    mountFile(path, data) {
      fs.mount(path, data);
    },
    unmountFile(path) {
      fs.unmount(path);
    },
  };
}

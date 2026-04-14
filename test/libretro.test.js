import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFile } from 'node:fs/promises'

import { LibretroHost } from '../web/libretro-host.js'
import { createWasiImports } from '../web/wasi.js'

const loadHostForCore = async (name) => {
  const wasmBytes = await readFile(new URL(`../build/cores/cores/${name}.wasm`, import.meta.url))
  const wasiBridge = createWasiImports()
  const host = new LibretroHost({ wasiBridge })
  await host.load(wasmBytes, { imports: wasiBridge.imports })
  wasiBridge.initialize(host.instance)
  host.initializeCore()
  return { host, wasiBridge }
}

describe('libretro cores', () => {
  for (const fixture of ['quicknes', 'gambatte', 'stella2014', 'beetle_pce_fast', 'beetle_ngp', 'smsplus_gx']) {
    test(`${fixture} instantiates and exposes AV info`, async () => {
      const { host } = await loadHostForCore(fixture)
      try {
        const avInfo = host.getSystemAvInfo()
        assert.ok(avInfo)
        assert.ok(avInfo.geometry.baseWidth > 0)
      } finally {
        host.shutdownCore()
      }
    })
  }
})

test('quicknes loadGame handles dummy ROM gracefully', async () => {
  const { host } = await loadHostForCore('quicknes')
  try {
    const dummy = new Uint8Array(1024)
    const result = host.loadGame({ path: '/virtual/dummy.nes', data: dummy })
    assert.strictEqual(typeof result, 'boolean')
  } finally {
    host.shutdownCore()
  }
})

/**
 * DeepSeekHashV1 PoW — Keccak sponge (NOT NIST SHA3).
 * Ported from OmniRoute open-sse/lib/deepseek-pow.ts (wasm + JS fallback).
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PowChallenge {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
  target_path: string
}

const nodeRequire = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const POW_DIR = path.join(here, 'deepseek-pow')

function powAssetDir(): string {
  if (fs.existsSync(path.join(POW_DIR, 'sha3_wasm_bg.wasm'))) return POW_DIR
  if (fs.existsSync(path.join(here, 'sha3_wasm_bg.wasm'))) return here
  return POW_DIR
}

// ── WASM solver ──────────────────────────────────────────────────────────

class DeepSeekHashWasm {
  private wasmInstance: {
    memory: WebAssembly.Memory
    wasm_solve: (...args: number[]) => void
    __wbindgen_add_to_stack_pointer: (n: number) => number
    __wbindgen_export_0: (size: number, align: number) => number
    __wbindgen_export_1: (
      ptr: number,
      oldSize: number,
      newSize: number,
      align: number,
    ) => number
  } | null = null
  private offset = 0
  private cachedUint8Memory: Uint8Array | null = null
  private cachedTextEncoder = new TextEncoder()

  private getCachedUint8Memory(): Uint8Array {
    if (!this.cachedUint8Memory?.byteLength) {
      this.cachedUint8Memory = new Uint8Array(this.wasmInstance!.memory.buffer)
    }
    return this.cachedUint8Memory
  }

  private encodeString(
    text: string,
    allocate: (size: number, align: number) => number,
    reallocate: (
      ptr: number,
      oldSize: number,
      newSize: number,
      align: number,
    ) => number,
  ): number {
    const strLength = text.length
    let ptr = allocate(strLength, 1) >>> 0
    const memory = this.getCachedUint8Memory()
    let asciiLength = 0

    for (; asciiLength < strLength; asciiLength++) {
      if (text.charCodeAt(asciiLength) > 127) break
      memory[ptr + asciiLength] = text.charCodeAt(asciiLength)
    }

    if (asciiLength !== strLength) {
      if (asciiLength > 0) text = text.slice(asciiLength)
      ptr = reallocate(ptr, strLength, asciiLength + text.length * 3, 1) >>> 0
      const result = this.cachedTextEncoder.encodeInto(
        text,
        this.getCachedUint8Memory().subarray(
          ptr + asciiLength,
          ptr + asciiLength + text.length * 3,
        ),
      )
      asciiLength += result.written || 0
      ptr = reallocate(ptr, asciiLength + text.length * 3, asciiLength, 1) >>> 0
    }

    this.offset = asciiLength
    return ptr
  }

  calculateHash(
    challenge: string,
    prefix: string,
    difficulty: number,
  ): number | undefined {
    const wasm = this.wasmInstance!
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = this.encodeString(
        challenge,
        wasm.__wbindgen_export_0,
        wasm.__wbindgen_export_1,
      )
      const len0 = this.offset
      const ptr1 = this.encodeString(
        prefix,
        wasm.__wbindgen_export_0,
        wasm.__wbindgen_export_1,
      )
      const len1 = this.offset
      wasm.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty)
      const dv = new DataView(wasm.memory.buffer)
      const status = dv.getInt32(retptr + 0, true)
      const value = dv.getFloat64(retptr + 8, true)
      return status === 0 ? undefined : value
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }

  async init(wasmPath: string): Promise<void> {
    const wasmBuffer = await fs.promises.readFile(wasmPath)
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} })
    this.wasmInstance = instance.exports as typeof this.wasmInstance
  }
}

let _wasmSolver: DeepSeekHashWasm | null = null
let _wasmInitFailed = false

async function getWasmSolver(): Promise<DeepSeekHashWasm | null> {
  if (_wasmInitFailed) return null
  if (_wasmSolver) return _wasmSolver
  try {
    const solver = new DeepSeekHashWasm()
    const wasmPath = path.join(powAssetDir(), 'sha3_wasm_bg.wasm')
    await solver.init(wasmPath)
    _wasmSolver = solver
    return solver
  } catch {
    _wasmInitFailed = true
    return null
  }
}

// ── JS Keccak fallback (OmniRoute deepseek-pow-solver.cjs) ────────────────

type Sponge = {
  absorb: (buf: Buffer) => void
  squeeze: (n: number) => Buffer
  copy: () => Sponge
}

let _U: (new (opts: { capacity: number; padding: number }) => Sponge) | undefined

function loadU() {
  if (_U === undefined) {
    // Split path so Turbopack cannot turn this into ./ROOT/… server-relative import.
    const rel = ['./deepseek-pow/', 'deepseek-pow-solver.cjs'].join('')
    const mod = nodeRequire(rel) as {
      U: new (opts: { capacity: number; padding: number }) => Sponge
    }
    _U = mod.U
  }
  return _U
}

function solveWithJS(
  challenge: string,
  prefix: string,
  difficulty: number,
): number {
  const U = loadU()
  const createHash = () => {
    const self: {
      _sponge: Sponge
      update: (s: string) => typeof self
      digest: (fmt?: string) => string
      copy: () => typeof self
    } = {} as never
    self._sponge = new U({ capacity: 256, padding: 6 })
    self.update = (s: string) => {
      self._sponge.absorb(Buffer.from(s, 'utf8'))
      return self
    }
    self.digest = (fmt?: string) =>
      self._sponge.squeeze(6).toString((fmt as BufferEncoding) || 'hex')
    self.copy = () => {
      const c = {} as typeof self
      c._sponge = self._sponge.copy()
      c.update = (s: string) => {
        c._sponge.absorb(Buffer.from(s, 'utf8'))
        return c
      }
      c.digest = (fmt?: string) =>
        c._sponge.squeeze(6).toString((fmt as BufferEncoding) || 'hex')
      return c
    }
    return self
  }

  const h = createHash()
  h.update(prefix)
  const max = Math.max(0, Math.floor(difficulty))
  for (let nonce = 0; nonce < max; nonce++) {
    if (h.copy().update(String(nonce)).digest('hex') === challenge) {
      return nonce
    }
  }
  return -1
}

async function solveNonce(challenge: PowChallenge): Promise<number> {
  const algorithm = challenge.algorithm || 'DeepSeekHashV1'
  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported DeepSeek PoW algorithm: ${algorithm}`)
  }
  const prefix = `${challenge.salt}_${challenge.expire_at}_`
  const difficulty = Number(challenge.difficulty) || 0
  const target = String(challenge.challenge || '').toLowerCase()
  if (!difficulty || !challenge.salt || !target) return -1

  const wasm = await getWasmSolver()
  if (wasm) {
    const answer = wasm.calculateHash(target, prefix, difficulty)
    if (answer === undefined || Number.isNaN(answer)) return -1
    return answer
  }
  return solveWithJS(target, prefix, difficulty)
}

/** Sync-looking API kept for callers; now async under the hood. */
export async function solvePowChallenge(
  challenge: PowChallenge,
): Promise<string | null> {
  try {
    const answer = await solveNonce(challenge)
    if (answer < 0) return null
    const result = {
      algorithm: challenge.algorithm || 'DeepSeekHashV1',
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path || '/api/v0/chat/completion',
    }
    return Buffer.from(JSON.stringify(result), 'utf8').toString('base64')
  } catch (e) {
    console.warn('[deepseek-pow] solve failed:', (e as Error).message)
    return null
  }
}

import { spawnSync } from 'node:child_process'
import type { Environment } from './context.ts'

// The spawning adapter is one implementation; the recording fake in
// src/testing/fakeHerdr.ts is the other. Responses stay `unknown` on purpose so
// decoding happens once, at the seam in tabs.ts.
export type HerdrInvoker = (args: string[]) => unknown

// The fields of spawnSync's result the unpacking reads. Named so unpacking is a
// pure function of a finished spawn: the fake proves the call sequence, this
// proves the response shape tabs.ts decodes against. Neither sees drift in
// Herdr itself, which only a live session shows.
export type HerdrSpawn = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export const unpackHerdrResponse = (bin: string, args: string[], spawned: HerdrSpawn): unknown => {
  if (spawned.error) throw new Error(`failed to spawn ${bin}: ${spawned.error.message}`)
  if (spawned.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} failed: ${(spawned.stderr || spawned.stdout).trim()}`)
  }
  // Most calls answer with a JSON envelope whose `result` is the payload; a few
  // (`plugin config-dir`) answer with a bare line, which is the value itself.
  try {
    return JSON.parse(spawned.stdout).result
  } catch {
    return spawned.stdout.trim()
  }
}

export const createHerdrInvoker = (env: Environment): HerdrInvoker => {
  const herdrBin = env.HERDR_BIN_PATH ?? 'herdr'
  return (args) =>
    unpackHerdrResponse(herdrBin, args, spawnSync(herdrBin, args, { encoding: 'utf8' }))
}

export const insideHerdr = (env: Environment) => env.HERDR_ENV === '1'

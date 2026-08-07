import { spawnSync } from 'node:child_process'
import type { Environment } from './context.ts'

// The spawning adapter is one implementation; the recording fake in
// src/testing/fakeHerdr.ts is the other. Responses stay `unknown` on purpose so
// decoding happens once, at the seam in tabs.ts.
export type HerdrInvoker = (args: string[]) => unknown

// The fields of spawnSync's result the unpacking reads, so unpacking is a pure
// function of a finished spawn. Both streams are null when the spawn never
// started, which is why `error` is checked first. Envelope shapes and what the
// two adapters do and do not prove: docs/herdr-quirks.md.
export type HerdrSpawn = {
  status: number | null
  stdout: string | null
  stderr: string | null
  error?: Error
}

export const unpackHerdrResponse = (bin: string, args: string[], spawned: HerdrSpawn): unknown => {
  if (spawned.error) throw new Error(`failed to spawn ${bin}: ${spawned.error.message}`)
  const stdout = spawned.stdout ?? ''
  if (spawned.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} failed: ${(spawned.stderr || stdout).trim()}`)
  }
  try {
    return JSON.parse(stdout).result
  } catch {
    return stdout.trim()
  }
}

export const createHerdrInvoker = (env: Environment): HerdrInvoker => {
  const herdrBin = env.HERDR_BIN_PATH ?? 'herdr'
  return (args) =>
    unpackHerdrResponse(herdrBin, args, spawnSync(herdrBin, args, { encoding: 'utf8' }))
}

export const insideHerdr = (env: Environment) => env.HERDR_ENV === '1'

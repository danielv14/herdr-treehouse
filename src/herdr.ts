import { spawnSync } from 'node:child_process'
import type { Environment } from './context.ts'

// Reaching Herdr is a dependency the engine accepts, not something it creates:
// the spawning adapter below is one implementation, the recording fake in
// src/testing/fakeHerdr.ts is the other. Responses stay `unknown` on purpose so
// decoding happens once, at the seam in tabs.ts, instead of at every call site.
export type HerdrInvoker = (args: string[]) => unknown

export const createHerdrInvoker = (env: Environment): HerdrInvoker => {
  const herdrBin = env.HERDR_BIN_PATH ?? 'herdr'
  return (args) => {
    const result = spawnSync(herdrBin, args, { encoding: 'utf8' })
    if (result.error) throw new Error(`failed to spawn ${herdrBin}: ${result.error.message}`)
    if (result.status !== 0) {
      throw new Error(`herdr ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
    }
    try {
      return JSON.parse(result.stdout).result
    } catch {
      return result.stdout.trim()
    }
  }
}

export const insideHerdr = (env: Environment) => env.HERDR_ENV === '1'

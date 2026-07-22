import { spawnSync } from 'node:child_process'

const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr'

export const herdr = (args: string[]): any => {
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

export const insideHerdr = () => process.env.HERDR_ENV === '1'

import type { Environment } from './herdr/context.ts'
import { insideHerdr, type HerdrInvoker } from './herdr/invoker.ts'
import { createTabChoreography, pluginConfigDir, type TabChoreography } from './herdr/tabs.ts'
import { spawnProcess, type ProcessRunner } from './processRunner.ts'

// What the commands need from the outside world. Only `invoke` is required;
// the rest have production defaults and exist so tests can drive the engine
// with no Herdr session, no HERDR_ENV and no real waiting.
export type Ask = (question: string) => Promise<string>

export type EngineDeps = {
  invoke: HerdrInvoker
  run?: ProcessRunner
  env?: Environment
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string) => void
  warn?: (message: string) => void
  ask?: Ask
}

// One readline per question, closed right away, so nothing holds stdin open
// between asks.
const askViaStdin: Ask = async (question) => {
  const { createInterface } = await import('node:readline/promises')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await readline.question(question)
  } finally {
    readline.close()
  }
}

export type ResolvedDeps = {
  invoke: HerdrInvoker
  run: ProcessRunner
  tabs: TabChoreography
  env: Environment
  insideHerdr: boolean
  log: (message: string) => void
  warn: (message: string) => void
  ask: Ask
  // Lazy: resolving may ask Herdr, and most commands never need the config dir.
  pluginConfigDir: () => string
}

export const resolveDeps = (deps: EngineDeps): ResolvedDeps => {
  const env = deps.env ?? process.env
  return {
    invoke: deps.invoke,
    run: deps.run ?? spawnProcess,
    tabs: createTabChoreography(deps.invoke, { sleep: deps.sleep, now: deps.now }),
    env,
    insideHerdr: insideHerdr(env),
    log: deps.log ?? console.log,
    warn: deps.warn ?? console.error,
    ask: deps.ask ?? askViaStdin,
    pluginConfigDir: () => pluginConfigDir(deps.invoke, env),
  }
}

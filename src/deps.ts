import type { Environment } from './context.ts'
import { insideHerdr, type HerdrInvoker } from './herdr.ts'
import { createTabChoreography, pluginConfigDir, type TabChoreography } from './tabs.ts'

// What the commands need from the outside world. Only `invoke` is required; the
// rest have production defaults and exist so tests can drive the engine with no
// Herdr session, no HERDR_ENV and no real waiting.
//
// The environment is one of those dependencies rather than a global reach: a
// test constructs the world it wants instead of mutating process.env around
// itself.
export type EngineDeps = {
  invoke: HerdrInvoker
  env?: Environment
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  warn?: (message: string) => void
  ask?: (question: string) => Promise<string>
}

// Interactive input is a dependency like output: the popup's questions cross
// the same resolved seam as its copy, so tests script answers and record what
// was asked. One readline per question, closed right away, so nothing holds
// stdin open between asks.
const askViaStdin = async (question: string): Promise<string> => {
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
  tabs: TabChoreography
  env: Environment
  insideHerdr: boolean
  log: (message: string) => void
  warn: (message: string) => void
  ask: (question: string) => Promise<string>
  // Lazy: resolving may ask Herdr, and most commands never need the config dir.
  pluginConfigDir: () => string
}

export const resolveDeps = (deps: EngineDeps): ResolvedDeps => {
  const env = deps.env ?? process.env
  return {
    invoke: deps.invoke,
    tabs: createTabChoreography(deps.invoke, { sleep: deps.sleep }),
    env,
    insideHerdr: insideHerdr(env),
    log: deps.log ?? console.log,
    warn: deps.warn ?? console.error,
    ask: deps.ask ?? askViaStdin,
    pluginConfigDir: () => pluginConfigDir(deps.invoke, env),
  }
}

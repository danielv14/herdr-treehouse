import type { Environment } from './context.ts'
import { insideHerdr, type HerdrInvoker } from './herdr.ts'
import { createTabChoreography, type TabChoreography } from './tabs.ts'

// What the commands need from the outside world. Only `invoke` is required; the
// rest have production defaults and exist so tests can drive the engine with no
// Herdr session, no HERDR_ENV and no real waiting.
//
// The environment is one of those dependencies rather than a global reach: every
// env fact the engine reads (the plugin invocation context, the clicked url, the
// target path convention, the caller pane and tab, the event payload, the plugin
// config dir, HERDR_ENV) comes from here, so a test constructs the world it wants
// instead of mutating process.env around itself.
export type EngineDeps = {
  invoke: HerdrInvoker
  env?: Environment
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  warn?: (message: string) => void
}

export type ResolvedDeps = {
  invoke: HerdrInvoker
  tabs: TabChoreography
  env: Environment
  insideHerdr: boolean
  log: (message: string) => void
  warn: (message: string) => void
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
  }
}

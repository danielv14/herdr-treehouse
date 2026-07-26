import { insideHerdr as insideHerdrEnv, type HerdrInvoker } from './herdr.ts'
import { createTabChoreography, type TabChoreography } from './tabs.ts'

// What the commands need from the outside world. Only `invoke` is required; the
// rest have production defaults and exist so tests can drive the engine with no
// Herdr session, no HERDR_ENV and no real waiting.
export type EngineDeps = {
  invoke: HerdrInvoker
  insideHerdr?: () => boolean
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  warn?: (message: string) => void
}

export type ResolvedDeps = {
  invoke: HerdrInvoker
  tabs: TabChoreography
  insideHerdr: () => boolean
  log: (message: string) => void
  warn: (message: string) => void
}

export const resolveDeps = (deps: EngineDeps): ResolvedDeps => ({
  invoke: deps.invoke,
  tabs: createTabChoreography(deps.invoke, { sleep: deps.sleep }),
  insideHerdr: deps.insideHerdr ?? insideHerdrEnv,
  log: deps.log ?? console.log,
  warn: deps.warn ?? console.error,
})

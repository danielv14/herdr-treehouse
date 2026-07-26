import { invocationTargetPath, readInvocationContext, TARGET_PATH_ENV } from './context.ts'
import { resolveDeps, type EngineDeps } from './deps.ts'
import type { CommandSpec } from './cli.ts'

export const ACTION_COMMAND: CommandSpec = {
  name: 'action',
  usage: ['treehouse action <up|down>'],
  summary: 'internal: plugin action entrypoint (keybindings, menu)',
  notes: [
    'Reads the Herdr invocation context and opens the matching popup pane.',
    'Declared in herdr-plugin.toml; not meant to be run by hand.',
  ],
  flags: [],
}

// Actions run headless, so anything that needs to prompt happens in a popup
// plugin pane. The popup process runs with cwd = plugin root, so the target path
// is resolved here (the only place that reads Herdr's context) and handed over
// through one env convention.
const POPUP_ENTRYPOINTS = {
  up: { entrypoint: 'up-interactive', prefer: 'workspace' },
  down: { entrypoint: 'down-interactive', prefer: 'pane' },
} as const

export const action = async (argv: string[], deps: EngineDeps) => {
  const { tabs, warn } = resolveDeps(deps)
  const [name, ...rest] = argv
  if (name !== 'up' && name !== 'down') {
    throw new Error(`action expects up or down (got ${name ?? 'nothing'})`)
  }
  if (rest.length > 0) throw new Error(`unknown option for action: ${rest[0]}`)

  // Visible via `herdr plugin log list --plugin treehouse`, which is the only
  // way to see what Herdr actually sent an action.
  warn(`invocation context: ${readInvocationContext().raw ?? '(none)'}`)

  const { entrypoint, prefer } = POPUP_ENTRYPOINTS[name]
  const target = invocationTargetPath({ prefer })
  tabs.openPluginPane({ entrypoint, env: target ? { [TARGET_PATH_ENV]: target } : undefined })
}

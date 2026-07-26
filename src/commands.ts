import { ACTION_COMMAND } from './actions.ts'
import { renderHelp, type CommandSpec } from './cli.ts'
import { DOWN_COMMAND } from './down.ts'
import { ONBOARD_COMMAND } from './onboard.ts'
import { UP_COMMAND } from './up.ts'

export const BOOTSTRAP_COMMAND: CommandSpec = {
  name: 'bootstrap',
  usage: ['treehouse bootstrap --from-event'],
  summary: 'internal: used by the worktree.created plugin hook',
  flags: [
    { flag: '--from-event', kind: 'boolean', key: 'fromEvent', help: 'read the worktree from HERDR_PLUGIN_EVENT_JSON and provision it' },
  ],
}

// Single registry: dispatch, --help and the tests that assert help covers every
// accepted flag all read the same list.
export const COMMANDS: CommandSpec[] = [
  UP_COMMAND,
  DOWN_COMMAND,
  ONBOARD_COMMAND,
  ACTION_COMMAND,
  BOOTSTRAP_COMMAND,
]

export const help = () =>
  renderHelp('treehouse - worktree-as-tab workflow engine for Herdr', COMMANDS, [
    'Config: config.toml in the plugin config dir (herdr plugin config-dir treehouse),',
    '        optionally overridden per repo by <repo>/.treehouse.toml',
  ])

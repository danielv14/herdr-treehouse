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

const HEADER = 'treehouse - worktree-as-tab workflow engine for Herdr'

const FOOTER = [
  'Config: config.toml in the plugin config dir (herdr plugin config-dir treehouse),',
  '        optionally overridden per repo by <repo>/.treehouse.toml',
]

export const help = () => renderHelp(HEADER, COMMANDS, FOOTER)

// `treehouse up --help` and friends: the declarations already carry the help
// text, so a single command's help is the same render over one entry.
export const commandHelp = (name: string): string | undefined => {
  const command = COMMANDS.find((candidate) => candidate.name === name)
  return command ? renderHelp(HEADER, [command], FOOTER) : undefined
}

import { ACTION_COMMAND, action } from './action.ts'
import { BOOTSTRAP_COMMAND, bootstrap } from './bootstrap.ts'
import { renderHelp, type Command, type CommandSpec } from '../cli.ts'
import { DOWN_COMMAND, down } from './down.ts'
import { LS_COMMAND, ls } from './ls.ts'
import { ONBOARD_COMMAND, onboard } from './onboard.ts'
import { REPORT_COMMAND, report } from './report.ts'
import { UP_COMMAND, up } from './up.ts'

// The one registry. Dispatch, --help and flag parsing all read this list, so
// help can never advertise a command the entrypoint does not route, and adding
// a command is one entry here rather than an entry plus a switch case.
export const COMMANDS: Command[] = [
  { ...UP_COMMAND, run: up },
  { ...DOWN_COMMAND, run: down },
  { ...LS_COMMAND, run: ls },
  { ...ONBOARD_COMMAND, run: onboard },
  { ...ACTION_COMMAND, run: action },
  { ...BOOTSTRAP_COMMAND, run: bootstrap },
  { ...REPORT_COMMAND, run: report },
]

export const findCommand = (name: string): Command | undefined =>
  COMMANDS.find((command) => command.name === name)

const HEADER = 'treehouse - worktree-as-tab workflow engine for Herdr'

const FOOTER = [
  'Config: config.toml in the plugin config dir (herdr plugin config-dir treehouse),',
  '        optionally overridden per repo by <repo>/.treehouse.toml',
]

export const help = () => renderHelp(HEADER, COMMANDS, FOOTER)

// `treehouse up --help` and friends: the declarations already carry the help
// text, so a single command's help is the same render over one entry.
export const commandHelp = (command: CommandSpec): string =>
  renderHelp(HEADER, [command], FOOTER)

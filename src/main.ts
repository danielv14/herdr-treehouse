import { bootstrapFromEvent } from './bootstrapEvent.ts'
import { down } from './down.ts'
import { onboard } from './onboard.ts'
import { up } from './up.ts'

const HELP = `workon — worktree-as-tab workflow engine for Herdr

Usage:
  workon up --branch <name> [--target <dir>]... [options]
  workon up --interactive
  workon down [--path <worktree>]
  workon onboard [--apply]

up: bootstrap a worktree (per repo config) and open it as a Herdr tab
  --repo <path>      repo to operate on (default: repo of cwd)
  --branch, -b       branch name, e.g. ABC-1234/fix-thing
  --target, -t       repo-relative dir passed to the bootstrap script (repeatable)
  --targets a,b      comma-separated form of --target
  --label <text>     tab label (default: ticket id or branch slug)
  --prompt <text>    task to hand the agent once it is idle
  --agent <cmd>      agent executable (default: repo config, then claude)
  --no-agent         skip starting an agent in the main pane
  --no-dev           skip the extra panes from repo config
  --focus            focus the new tab (default: stay where you are)

down: remove the worktree and close its tab
  Refuses on uncommitted changes and on panes with running processes.
  --path <worktree>  worktree to tear down (default: cwd)

onboard: scan the current repo and propose a config entry
  --apply            append the proposal to the plugin config

Config: config.toml in the plugin config dir (herdr plugin config-dir workon),
        optionally overridden per repo by <repo>/.workon.toml`

const main = async () => {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'up':
      await up(rest)
      break
    case 'down':
      await down(rest)
      break
    case 'onboard':
      await onboard(rest)
      break
    case 'bootstrap':
      if (rest[0] === '--from-event') await bootstrapFromEvent()
      else throw new Error('bootstrap only supports --from-event (used by the worktree.created hook)')
      break
    case undefined:
    case '--help':
    case '-h':
      console.log(HELP)
      break
    default:
      throw new Error(`unknown command: ${command} (see workon --help)`)
  }
}

// The interactive popup pane closes the moment the process exits, so hold it
// open until the user has read the summary or error.
const holdForInteractive = async () => {
  if (!process.argv.includes('--interactive')) return
  const { createInterface } = await import('node:readline/promises')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  await readline.question('\n[Enter] stänger')
  readline.close()
}

try {
  await main()
  await holdForInteractive()
} catch (error) {
  console.error(`workon: ${error instanceof Error ? error.message : error}`)
  await holdForInteractive()
  process.exit(1)
}

import { action } from './actions.ts'
import { bootstrapFromEvent } from './bootstrapEvent.ts'
import { commandHelp, help } from './commands.ts'
import type { EngineDeps } from './deps.ts'
import { down } from './down.ts'
import { createHerdrInvoker } from './herdr.ts'
import { onboard } from './onboard.ts'
import { up } from './up.ts'

const main = async (deps: EngineDeps) => {
  const [command, ...rest] = process.argv.slice(2)

  // `treehouse up --help` asks about up, not about the parser.
  if (rest.includes('--help') || rest.includes('-h')) {
    const rendered = command === undefined ? undefined : commandHelp(command)
    if (rendered) {
      console.log(rendered)
      return
    }
  }

  switch (command) {
    case 'up':
      await up(rest, deps)
      break
    case 'down':
      await down(rest, deps)
      break
    case 'onboard':
      await onboard(rest, deps)
      break
    case 'action':
      await action(rest, deps)
      break
    case 'bootstrap':
      if (rest[0] === '--from-event') await bootstrapFromEvent(deps)
      else throw new Error('bootstrap only supports --from-event (used by the worktree.created hook)')
      break
    case undefined:
    case '--help':
    case '-h':
      console.log(help())
      break
    default:
      throw new Error(`unknown command: ${command} (see treehouse --help)`)
  }
}

// The interactive popup pane closes the moment the process exits, so hold it
// open until the user has read the summary or error.
const holdForInteractive = async () => {
  if (!process.argv.includes('--interactive')) return
  const { createInterface } = await import('node:readline/promises')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  await readline.question('\n[Enter] to close')
  readline.close()
}

try {
  await main({ invoke: createHerdrInvoker() })
  await holdForInteractive()
} catch (error) {
  console.error(`treehouse: ${error instanceof Error ? error.message : error}`)
  await holdForInteractive()
  process.exit(1)
}

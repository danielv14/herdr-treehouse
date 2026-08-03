import { isInteractiveInvocation } from './cli.ts'
import { commandHelp, findCommand, help } from './commands/registry.ts'
import { resolveDeps, type EngineDeps } from './deps.ts'
import { createHerdrInvoker } from './herdr/invoker.ts'

// Takes argv and deps rather than reading the globals, so it can be imported
// and driven in tests.
export const runCommand = async (argv: string[], deps: EngineDeps) => {
  const { log } = resolveDeps(deps)
  const [name, ...rest] = argv

  if (name === undefined || name === '--help' || name === '-h') {
    log(help())
    return
  }

  const command = findCommand(name)
  if (!command) throw new Error(`unknown command: ${name} (see treehouse --help)`)

  // `treehouse up --help` asks about up, not about the parser.
  if (rest.includes('--help') || rest.includes('-h')) {
    log(commandHelp(command))
    return
  }

  await command.run(rest, deps)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const deps: EngineDeps = { invoke: createHerdrInvoker(process.env) }
  const { ask } = resolveDeps(deps)
  // The interactive popup pane closes the moment the process exits, so hold it
  // open until the user has read the summary or error.
  const holdOpen = isInteractiveInvocation(findCommand(argv[0] ?? ''), argv.slice(1))
  try {
    await runCommand(argv, deps)
    if (holdOpen) await ask('\n[Enter] to close')
  } catch (error) {
    console.error(`treehouse: ${error instanceof Error ? error.message : error}`)
    if (holdOpen) await ask('\n[Enter] to close')
    process.exit(1)
  }
}

import { commandHelp, findCommand, help } from './commands.ts'
import { resolveDeps, type EngineDeps } from './deps.ts'
import { createHerdrInvoker } from './herdr.ts'

// Dispatch is a lookup in the same registry help and parsing read: no
// per-command switch, so a command cannot be documented without being routed.
// Exported and argv-taking so it can be imported and driven in tests; the
// process-level wiring below only runs when this file is the entrypoint.
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

// The interactive popup pane closes the moment the process exits, so hold it
// open until the user has read the summary or error.
const holdForInteractive = async (argv: string[]) => {
  if (!argv.includes('--interactive')) return
  const { createInterface } = await import('node:readline/promises')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  await readline.question('\n[Enter] to close')
  readline.close()
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  try {
    await runCommand(argv, { invoke: createHerdrInvoker(process.env) })
    await holdForInteractive(argv)
  } catch (error) {
    console.error(`treehouse: ${error instanceof Error ? error.message : error}`)
    await holdForInteractive(argv)
    process.exit(1)
  }
}

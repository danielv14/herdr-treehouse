import { beforeEach, describe, expect, test } from 'bun:test'
import { COMMANDS } from './commands.ts'
import type { EngineDeps } from './deps.ts'
import { runCommand } from './main.ts'
import { expectRejection } from './testing/expectRejection.ts'
import { createFakeHerdr, type FakeResponses } from './testing/fakeHerdr.ts'

let logged: string[]

const deps = (responses: FakeResponses = {}): EngineDeps => ({
  invoke: createFakeHerdr(responses).invoke,
  env: {},
  log: (message) => logged.push(message),
  warn: (message) => logged.push(message),
})

beforeEach(() => {
  logged = []
})

describe('dispatch', () => {
  test('an unknown command errors and points at help', async () => {
    await expectRejection(
      runCommand(['sideways'], deps()),
      'unknown command: sideways (see treehouse --help)',
    )
  })

  test('a known command reaches its handler with the remaining argv', async () => {
    const fake = createFakeHerdr({ 'plugin pane open': {} })
    await runCommand(['action', 'down'], {
      invoke: fake.invoke,
      env: { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: '/dev/repo-abc-1' }) },
      log: (message) => logged.push(message),
      warn: (message) => logged.push(message),
    })
    expect(fake.commands()).toEqual([
      'plugin pane open --plugin treehouse --entrypoint down-interactive --placement popup --focus --env TREEHOUSE_TARGET_PATH=/dev/repo-abc-1',
    ])
  })

  test('every registry entry is routable by its own name', async () => {
    // Dispatch resolves each declared name rather than a hand-written subset:
    // a command in the registry but missing from the router would fail here
    // with "unknown command" instead of rendering its help.
    for (const command of COMMANDS) {
      logged = []
      await runCommand([command.name, '--help'], deps())
      expect(logged.join('\n')).toContain(`${command.name}: ${command.summary}`)
    }
  })
})

describe('help', () => {
  test('bare, --help and -h all render every command', async () => {
    for (const argv of [[], ['--help'], ['-h']]) {
      logged = []
      await runCommand(argv, deps())
      for (const command of COMMANDS) expect(logged.join('\n')).toContain(`${command.name}: ${command.summary}`)
    }
  })

  test('<command> --help renders that command only', async () => {
    await runCommand(['up', '--help'], deps())
    const rendered = logged.join('\n')
    expect(rendered).toContain('up: bootstrap a worktree')
    expect(rendered).not.toContain('down: remove the worktree')
  })

  test('<command> -h is the same as --help, and the handler does not run', async () => {
    const fake = createFakeHerdr({})
    await runCommand(['down', '-h'], { invoke: fake.invoke, env: {}, log: (message) => logged.push(message) })
    expect(logged.join('\n')).toContain('down: remove the worktree')
    expect(fake.calls).toHaveLength(0)
  })

  test('--help after an unknown command is still an unknown command', async () => {
    await expectRejection(runCommand(['nope', '--help'], deps()), 'unknown command: nope')
  })
})

describe('bootstrap flags', () => {
  // The declaration used to be decorative here: the entrypoint hand-checked
  // argv[0] instead of parsing through it.
  test('an unknown flag is reported by the parser, naming the command', async () => {
    await expectRejection(runCommand(['bootstrap', '--now'], deps()), 'unknown option for bootstrap: --now')
  })

  test('without --from-event it refuses', async () => {
    await expectRejection(
      runCommand(['bootstrap'], deps()),
      'bootstrap only supports --from-event (used by the worktree.created hook)',
    )
  })

  test('--from-event with no payload in the environment is a no-op', async () => {
    await runCommand(['bootstrap', '--from-event'], deps())
    expect(logged).toContain('no HERDR_PLUGIN_EVENT_JSON in environment, nothing to do')
  })
})

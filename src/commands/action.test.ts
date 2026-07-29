import { beforeEach, describe, expect, test } from 'bun:test'
import { action } from './action.ts'
import type { Environment } from '../herdr/context.ts'
import { expectRejection } from '../testing/expectRejection.ts'
import { createFakeHerdr } from '../testing/fakeHerdr.ts'

let warned: string[]
let env: Environment

beforeEach(() => {
  warned = []
  env = {}
})

const run = async (name: string) => {
  const fake = createFakeHerdr({ 'plugin pane open': {} })
  await action([name], { invoke: fake.invoke, env, warn: (message) => warned.push(message) })
  return fake
}

describe('action', () => {
  beforeEach(() => {
    env = {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_cwd: '/dev/repo',
        focused_pane_cwd: '/dev/repo-abc-1',
      }),
    }
  })

  test('up opens the interactive popup targeting the focused workspace\'s repo', async () => {
    const fake = await run('up')
    expect(fake.commands()).toEqual([
      'plugin pane open --plugin treehouse --entrypoint up-interactive --placement popup --focus --env TREEHOUSE_TARGET_PATH=/dev/repo',
    ])
  })

  test('down opens the teardown popup targeting the focused pane\'s worktree', async () => {
    const fake = await run('down')
    expect(fake.commands()).toEqual([
      'plugin pane open --plugin treehouse --entrypoint down-interactive --placement popup --focus --env TREEHOUSE_TARGET_PATH=/dev/repo-abc-1',
    ])
  })

  test('the raw context is logged, so the plugin log shows what Herdr sent', async () => {
    await run('up')
    expect(warned[0]).toBe('invocation context: {"workspace_cwd":"/dev/repo","focused_pane_cwd":"/dev/repo-abc-1"}')
  })

  test('a context with no cwd opens the popup without a target, and the popup refuses', async () => {
    env = { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ invocation_source: 'keybinding' }) }
    const fake = await run('up')
    expect(fake.commands()[0]).not.toContain('--env')
  })

  test('an unknown action name is refused', async () => {
    await expectRejection(
      action(['sideways'], { invoke: createFakeHerdr({}).invoke, env, warn: () => {} }),
      'action expects up or down (got sideways)',
    )
    await expectRejection(
      action([], { invoke: createFakeHerdr({}).invoke, env, warn: () => {} }),
      'action expects up or down (got nothing)',
    )
  })

  test('a prototype property name is refused like any other unknown action', async () => {
    // `in` would have let 'toString' through the guard and opened a popup with
    // --entrypoint undefined.
    await expectRejection(
      action(['toString'], { invoke: createFakeHerdr({}).invoke, env, warn: () => {} }),
      'action expects up or down (got toString)',
    )
  })

  test('trailing arguments are refused rather than ignored', async () => {
    await expectRejection(
      action(['up', '--branch', 'x'], { invoke: createFakeHerdr({}).invoke, env, warn: () => {} }),
      'unknown option for action: --branch',
    )
  })
})

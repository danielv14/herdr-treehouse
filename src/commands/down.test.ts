import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Environment } from '../herdr/context.ts'
import type { EngineDeps } from '../deps.ts'
import { down } from './down.ts'
import { expectRejection } from '../testing/expectRejection.ts'
import { createFakeHerdr, type FakeHerdr } from '../testing/fakeHerdr.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'

let repo: TempRepo
let worktree: string
let logged: string[]
let sleeps: number[]
let originalCwd: string

// Inside Herdr by default; a test that cares about the caller's pane/tab, the
// popup env convention or the plugin context adds those keys itself.
const deps = (fake: FakeHerdr, env: Environment = {}): EngineDeps => ({
  invoke: fake.invoke,
  env: { HERDR_ENV: '1', ...env },
  sleep: async (ms) => {
    sleeps.push(ms)
  },
  now: () => 1234,
  log: (message) => logged.push(message),
  warn: (message) => logged.push(message),
})

const busyProcess = (cmdline: string) => ({
  process_info: { foreground_processes: [{ name: 'node', cmdline }] },
})

const paneList = (panes: Array<Record<string, unknown>>) => ({ panes })

beforeEach(() => {
  originalCwd = process.cwd()
  repo = createTempRepo('my-repo')
  worktree = join(repo.parent, 'my-repo-abc-1')
  repo.git('worktree', 'add', worktree, '-b', 'ABC-1/fix', '--no-track', 'master')
  logged = []
  sleeps = []
})

afterEach(() => {
  process.chdir(originalCwd)
  repo.cleanup()
})

describe('down', () => {
  test('removes the worktree, leaves the branch and closes its tab', async () => {
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([{ pane_id: 'p1', tab_id: 't1', cwd: worktree }]),
      'pane process-info': { process_info: { foreground_processes: [{ name: 'zsh' }] } },
      'tab close': {},
      'workspace report-metadata': {},
    })
    await down(['--path', worktree], deps(fake))

    expect(existsSync(worktree)).toBe(false)
    expect(repo.git('branch', '--list', 'ABC-1/fix')).toContain('ABC-1/fix')
    expect(fake.commands()).toContain('tab close t1')
    expect(logged).toContain(`removed worktree: ${worktree}`)
    expect(logged).toContain('branch left in place (cleaned up via PR merge as usual)')
    // The sidebar token refresh happens before tabs close: closing the caller's
    // own tab can end the process.
    const commands = fake.commands()
    // The last worktree just went away, so the token is cleared, not set to 0.
    const report = 'workspace report-metadata wA --source treehouse --clear-token worktrees --seq 1234'
    expect(commands).toContain(report)
    expect(commands.indexOf(report)).toBeLessThan(commands.indexOf('tab close t1'))
  })

  test('refuses when a pane reports a confirmed busy process, and keeps the worktree', async () => {
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([{ pane_id: 'p1', tab_id: 't1', cwd: worktree }]),
      'pane process-info': busyProcess('npm run dev'),
    })
    await expectRejection(
      down(['--path', worktree], deps(fake)),
      'panes in the worktree tab still run processes:\n  p1: npm run dev',
    )
    expect(existsSync(worktree)).toBe(true)
    expect(fake.callsMatching('tab close')).toHaveLength(0)
    // Two snapshots, 750ms apart: one is not enough to tell a dev server from
    // prompt tooling.
    expect(fake.callsMatching('pane process-info')).toHaveLength(2)
    expect(sleeps).toEqual([750])
  })

  test('a process that is gone on the second look does not block teardown', async () => {
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([{ pane_id: 'p1', tab_id: 't1', cwd: worktree }]),
      'pane process-info': [busyProcess('starship prompt'), { process_info: { foreground_processes: [] } }],
      'tab close': {},
      'workspace report-metadata': {},
    })
    await down(['--path', worktree], deps(fake))
    expect(existsSync(worktree)).toBe(false)
  })

  test('an idle agent in the tab is not a reason to refuse', async () => {
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([
        { pane_id: 'p1', tab_id: 't1', cwd: worktree, agent: 'claude', agent_status: 'idle' },
      ]),
      'tab close': {},
      'workspace report-metadata': {},
    })
    await down(['--path', worktree], deps(fake))
    expect(existsSync(worktree)).toBe(false)
  })

  test('the caller\'s own tab is closed last', async () => {
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([
        { pane_id: 'p1', tab_id: 't1', cwd: worktree },
        { pane_id: 'p9', tab_id: 't2', cwd: join(worktree, 'services/web') },
      ]),
      'pane process-info': { process_info: { foreground_processes: [{ name: 'zsh' }] } },
      'tab close': {},
      'workspace report-metadata': {},
    })
    await down(['--path', worktree], deps(fake, { HERDR_TAB_ID: 't1', HERDR_PANE_ID: 'p1' }))
    expect(fake.callsMatching('tab close').map((call) => call[2])).toEqual(['t2', 't1'])
    expect(logged).toContain('closing this tab last (the teardown ran from inside it)')
  })

  test('the caller\'s own pane is not probed for busy processes', async () => {
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([{ pane_id: 'p1', tab_id: 't1', cwd: worktree }]),
      'tab close': {},
      'workspace report-metadata': {},
    })
    await down(['--path', worktree], deps(fake, { HERDR_PANE_ID: 'p1' }))
    expect(fake.callsMatching('pane process-info')).toHaveLength(0)
    expect(existsSync(worktree)).toBe(false)
  })

  test('uncommitted changes stop the teardown before any Herdr call', async () => {
    writeFileSync(join(worktree, 'dirty.txt'), 'work in progress')
    const fake = createFakeHerdr({})
    await expectRejection(
      down(['--path', worktree], deps(fake)),
      'worktree has uncommitted changes, refusing to remove',
    )
    expect(existsSync(worktree)).toBe(true)
    expect(fake.calls).toHaveLength(0)
  })

  test('one of two worktrees of the same ticket goes down without touching the other', async () => {
    // Two branches of ABC-1, so the second sits at the disambiguated path.
    // Teardown resolves from cwd, which is per worktree and not per ticket.
    const second = join(repo.parent, 'my-repo-abc-1-second-take')
    repo.git('worktree', 'add', second, '-b', 'ABC-1/second-take', '--no-track', 'master')
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([
        { pane_id: 'p1', tab_id: 't1', cwd: worktree },
        { pane_id: 'p2', tab_id: 't2', cwd: second },
      ]),
      'pane process-info': { process_info: { foreground_processes: [{ name: 'zsh' }] } },
      'tab close': {},
      'workspace report-metadata': {},
    })

    process.chdir(second)
    await down([], deps(fake))

    expect(existsSync(second)).toBe(false)
    expect(existsSync(worktree)).toBe(true)
    // Only the tab standing in the removed worktree is closed.
    expect(fake.callsMatching('tab close').map((call) => call[2])).toEqual(['t2'])
    expect(repo.git('worktree', 'list')).toContain('my-repo-abc-1 ')
  })

  test('the short-path worktree of a shared ticket goes down the same way', async () => {
    const second = join(repo.parent, 'my-repo-abc-1-second-take')
    repo.git('worktree', 'add', second, '-b', 'ABC-1/second-take', '--no-track', 'master')
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([
        { pane_id: 'p1', tab_id: 't1', cwd: worktree },
        { pane_id: 'p2', tab_id: 't2', cwd: second },
      ]),
      'pane process-info': { process_info: { foreground_processes: [{ name: 'zsh' }] } },
      'tab close': {},
      'workspace report-metadata': {},
    })

    process.chdir(worktree)
    await down([], deps(fake))

    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(second)).toBe(true)
    expect(fake.callsMatching('tab close').map((call) => call[2])).toEqual(['t1'])
  })

  test('a main checkout is refused', async () => {
    await expectRejection(
      down(['--path', repo.root], deps(createFakeHerdr({}))),
      'is not a linked worktree (refusing to touch a main checkout)',
    )
    expect(existsSync(repo.root)).toBe(true)
  })

  test('a plugin invocation with no target refuses instead of falling back to cwd', async () => {
    // cwd is the plugin's own root for an action, so teardown used to reach the
    // main-checkout refusal by luck and blame the wrong path. Same rule as up's.
    const fake = createFakeHerdr({})
    await expectRejection(
      down([], deps(fake, { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ invocation_source: 'keybinding' }) })),
      'plugin invocation: could not derive the target repo',
    )
    // Before any git or Herdr work: the fake would throw on an unscripted call,
    // so an empty call list is the proof it refused first.
    expect(fake.calls).toHaveLength(0)
    expect(logged).toHaveLength(0)
  })

  test('a repo with no open workspace still removes the worktree', async () => {
    const fake = createFakeHerdr({ 'worktree list': {} })
    await down(['--path', worktree], deps(fake))
    expect(logged).toContain('repo has no open workspace in Herdr; removing the worktree only')
    expect(existsSync(worktree)).toBe(false)
  })

  test('outside a Herdr session it removes the worktree without touching tabs', async () => {
    const fake = createFakeHerdr({})
    await down(['--path', worktree], deps(fake, { HERDR_ENV: undefined }))
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(worktree)).toBe(false)
  })

  test('--interactive with a no answer aborts and keeps the worktree', async () => {
    const asked: string[] = []
    const fake = createFakeHerdr({})
    await down(['--path', worktree, '--interactive'], {
      ...deps(fake),
      ask: async (question) => {
        asked.push(question)
        return 'n'
      },
    })
    expect(asked).toEqual([`Remove worktree ${worktree} and close its tab? [y/N] `])
    expect(logged).toContain('Aborted.')
    expect(existsSync(worktree)).toBe(true)
    expect(fake.calls).toHaveLength(0)
  })

  test('files written while the confirm prompt is open are still caught', async () => {
    // The prompt can sit open while another pane writes; the dirty check must
    // act on the tree the user said yes to, not the snapshot from before.
    const fake = createFakeHerdr({})
    await expectRejection(
      down(['--path', worktree, '--interactive'], {
        ...deps(fake),
        ask: async () => {
          writeFileSync(join(worktree, 'late.txt'), 'written mid-prompt')
          return 'y'
        },
      }),
      'worktree has uncommitted changes, refusing to remove',
    )
    expect(existsSync(worktree)).toBe(true)
    expect(fake.calls).toHaveLength(0)
  })

  test('--interactive with a yes answer removes the worktree', async () => {
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': paneList([{ pane_id: 'p1', tab_id: 't1', cwd: worktree }]),
      'pane process-info': { process_info: { foreground_processes: [{ name: 'zsh' }] } },
      'tab close': {},
      'workspace report-metadata': {},
    })
    await down(['--path', worktree, '--interactive'], { ...deps(fake), ask: async () => ' Y ' })
    expect(existsSync(worktree)).toBe(false)
  })

  test('the target path comes from the popup env convention when no --path is given', async () => {
    const fake = createFakeHerdr({ 'worktree list': {} })
    await down([], deps(fake, { TREEHOUSE_TARGET_PATH: worktree }))
    expect(existsSync(worktree)).toBe(false)
  })

  test('the target path falls back to the focused pane from the plugin context', async () => {
    const fake = createFakeHerdr({ 'worktree list': {} })
    await down([], deps(fake, {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: repo.root, focused_pane_cwd: worktree }),
    }))
    expect(existsSync(worktree)).toBe(false)
  })
})

describe('a failed workspace lookup', () => {
  // down.ts promises that inspection failures abort rather than degrade:
  // proceeding without the busy check could delete a worktree from under a
  // running dev server.
  test('aborts the teardown instead of removing the worktree unchecked', async () => {
    const fake = createFakeHerdr({})
    await expectRejection(down(['--path', worktree], deps(fake)), 'no response scripted')
    expect(existsSync(worktree)).toBe(true)
  })
})

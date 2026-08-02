import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Environment } from '../herdr/context.ts'
import type { EngineDeps } from '../deps.ts'
import { createFakeHerdr, type FakeHerdr } from '../testing/fakeHerdr.ts'
import { expectRejection } from '../testing/expectRejection.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'
import { ls } from './ls.ts'

// Drives ls end to end: real repos and worktrees, scripted Herdr responses.

let repo: TempRepo
let configDir: string
let logged: string[]

const env = (overrides: Environment = {}): Environment => ({
  HERDR_ENV: '1',
  HERDR_PLUGIN_CONFIG_DIR: configDir,
  ...overrides,
})

const deps = (fake: FakeHerdr, overrides: Environment = {}): EngineDeps => ({
  invoke: fake.invoke,
  env: env(overrides),
  log: (message) => logged.push(message),
  warn: (message) => logged.push(message),
})

const writeCentralConfig = (toml: string) =>
  writeFileSync(join(configDir, 'config.toml'), toml)

const addWorktree = (name: string, branch: string) => {
  const path = join(repo.parent, name)
  repo.git('worktree', 'add', path, '-b', branch, '--no-track', 'master')
  return path
}

beforeEach(() => {
  repo = createTempRepo('my-repo')
  configDir = join(repo.parent, 'config')
  mkdirSync(configDir, { recursive: true })
  writeCentralConfig(`
[repos.my-repo]
root = ${JSON.stringify(repo.root)}
base = "master"
`)
  logged = []
})

afterEach(() => {
  repo.cleanup()
})

describe('ls', () => {
  test('a worktree with a tab renders one row with git and Herdr facts', async () => {
    const worktree = addWorktree('my-repo-abc-1', 'ABC-1/fix')
    writeFileSync(join(worktree, 'wip.txt'), 'wip')
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'pane list': {
        panes: [{ pane_id: 'p1', tab_id: 't1', cwd: worktree, agent: 'claude', agent_status: 'idle' }],
      },
    })
    await ls([], deps(fake))

    const table = logged.join('\n')
    expect(table).toContain('REPO')
    expect(table).toContain('TAB')
    const row = logged.find((line) => line.includes('ABC-1/fix'))
    expect(row).toContain('my-repo')
    expect(row).toContain('1 dirty')
    expect(row).toContain('+0/-0')
    expect(row).toContain('claude (idle)')
    expect(row).toContain('../my-repo-abc-1')
  })

  test('outside Herdr the tab column is omitted and no workspace or pane is asked for', async () => {
    // The config dir comes from the env here; without it, resolving it is one
    // herdr invocation even outside a session.
    addWorktree('my-repo-abc-1', 'ABC-1/fix')
    const fake = createFakeHerdr({})
    await ls([], deps(fake, { HERDR_ENV: undefined }))
    expect(fake.callsMatching('worktree list')).toHaveLength(0)
    expect(fake.callsMatching('pane list')).toHaveLength(0)
    expect(logged.join('\n')).toContain('ABC-1/fix')
    expect(logged[0]).not.toContain('TAB')
  })

  test('--json publishes the stable shape with null for absent facts', async () => {
    const worktree = addWorktree('my-repo-abc-1', 'ABC-1/fix')
    const fake = createFakeHerdr({ 'worktree list': { source: {} } })
    await ls(['--json'], deps(fake))

    const parsed = JSON.parse(logged.join('\n'))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual({
      repo: 'my-repo',
      path: worktree,
      branch: 'ABC-1/fix',
      ticket: 'abc-1',
      id: 'abc-1',
      managed: true,
      missing: false,
      base: 'master',
      dirtyFiles: 0,
      ahead: 0,
      behind: 0,
      lastCommitAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      tab: null,
      pr: null,
    })
  })

  test('an unmanaged worktree is marked and explained', async () => {
    addWorktree('elsewhere', 'experiment')
    const fake = createFakeHerdr({ 'worktree list': { source: {} } })
    await ls([], deps(fake))
    const row = logged.find((line) => line.includes('experiment'))
    expect(row).toContain('../elsewhere *')
    expect(logged.join('\n')).toContain("* path does not match the repo's worktree_dir convention")
  })

  test('a second worktree of one ticket is not marked as off-convention', async () => {
    addWorktree('my-repo-abc-1', 'ABC-1/reducer')
    addWorktree('my-repo-abc-1-state-machine', 'ABC-1/state-machine')
    const fake = createFakeHerdr({ 'worktree list': { source: {} } })
    await ls([], deps(fake))

    const row = logged.find((line) => line.includes('ABC-1/state-machine'))
    expect(row).toContain('../my-repo-abc-1-state-machine')
    expect(row).not.toContain('*')
    expect(logged.join('\n')).not.toContain("* path does not match the repo's worktree_dir convention")
  })

  test('--repo filters to one configured repo and an unknown name is refused', async () => {
    addWorktree('my-repo-abc-1', 'ABC-1/fix')
    const fake = createFakeHerdr({ 'worktree list': { source: {} } })
    await ls(['--repo', 'my-repo'], deps(fake))
    expect(logged.join('\n')).toContain('ABC-1/fix')

    await expectRejection(
      ls(['--repo', 'nope'], deps(createFakeHerdr({}))),
      'no configured repo named nope (known: my-repo)',
    )
  })

  test('no worktrees prints a hint instead of an empty table', async () => {
    const fake = createFakeHerdr({ 'worktree list': { source: {} } })
    await ls([], deps(fake))
    expect(logged).toContain('no worktrees (treehouse up creates one)')
  })

  test('a Herdr hiccup degrades the tab column with a warning, rows still print', async () => {
    addWorktree('my-repo-abc-1', 'ABC-1/fix')
    const fake = createFakeHerdr({}) // every herdr call throws
    await ls([], deps(fake))
    expect(logged.join('\n')).toContain('ABC-1/fix')
    expect(logged.some((line) => line.includes('could not read tabs for my-repo'))).toBe(true)
  })
})

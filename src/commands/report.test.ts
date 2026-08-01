import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Environment } from '../herdr/context.ts'
import type { EngineDeps } from '../deps.ts'
import { createFakeHerdr, type FakeHerdr } from '../testing/fakeHerdr.ts'
import { expectRejection } from '../testing/expectRejection.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'
import { report } from './report.ts'

let repo: TempRepo
let configDir: string
let logged: string[]

const deps = (fake: FakeHerdr, overrides: Environment = {}): EngineDeps => ({
  invoke: fake.invoke,
  env: { HERDR_ENV: '1', HERDR_PLUGIN_CONFIG_DIR: configDir, ...overrides },
  now: () => 1234,
  log: (message) => logged.push(message),
  warn: (message) => logged.push(message),
})

beforeEach(() => {
  repo = createTempRepo('my-repo')
  configDir = join(repo.parent, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'config.toml'),
    `[repos.my-repo]\nroot = ${JSON.stringify(repo.root)}\n`,
  )
  logged = []
})

afterEach(() => {
  repo.cleanup()
})

describe('report', () => {
  test('reports the worktree count for each repo with an open workspace', async () => {
    repo.git('worktree', 'add', join(repo.parent, 'my-repo-abc-1'), '-b', 'ABC-1/fix', '--no-track', 'master')
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'workspace report-metadata': {},
    })
    await report([], deps(fake))
    expect(fake.commands()).toContain(
      'workspace report-metadata wA --source treehouse --token worktrees=1 --seq 1234 --ttl-ms 86400000',
    )
    expect(logged).toContain('my-repo: worktrees=1 (workspace wA)')
  })

  test('a repo with no open workspace is skipped without reporting', async () => {
    const fake = createFakeHerdr({ 'worktree list': { source: {} } })
    await report([], deps(fake))
    expect(fake.callsMatching('workspace report-metadata')).toHaveLength(0)
  })

  test('one broken repo does not stop the others', async () => {
    const other = join(repo.parent, 'other-repo')
    mkdirSync(other) // exists but is not a git repo
    writeFileSync(
      join(configDir, 'config.toml'),
      `[repos.broken]\nroot = ${JSON.stringify(other)}\n\n[repos.my-repo]\nroot = ${JSON.stringify(repo.root)}\n`,
    )
    const fake = createFakeHerdr({
      'worktree list': { source: { source_workspace_id: 'wA' } },
      'workspace report-metadata': {},
    })
    await report([], deps(fake))
    expect(logged.some((line) => line.includes('skipping broken'))).toBe(true)
    expect(logged).toContain('my-repo: no worktrees, worktrees token cleared (workspace wA)')
  })

  test('outside a Herdr session it refuses', async () => {
    await expectRejection(
      report([], deps(createFakeHerdr({}), { HERDR_ENV: undefined })),
      'not inside a Herdr session',
    )
  })
})

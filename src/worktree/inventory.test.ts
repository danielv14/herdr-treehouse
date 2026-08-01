import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachTabFacts, collectRepoInventory, type RepoInventory } from './inventory.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'

// Against real repos, like the git module's own tests: the records are what a
// user observes through ls and what prune will act on.

let repo: TempRepo
let warned: string[]

const warn = (message: string) => warned.push(message)

const config = (overrides: Partial<{ base: string; worktree_dir: string }> = {}) => ({
  root: repo.root,
  base: 'master',
  ...overrides,
})

beforeEach(() => {
  repo = createTempRepo('my-repo')
  warned = []
})

afterEach(() => {
  repo.cleanup()
})

describe('collectRepoInventory', () => {
  test('a conventional worktree comes back managed, with naming and git facts', () => {
    const worktree = join(repo.parent, 'my-repo-abc-1')
    repo.git('worktree', 'add', worktree, '-b', 'ABC-1/fix-thing', '--no-track', 'master')
    writeFileSync(join(worktree, 'wip.txt'), 'wip')

    const inventory = collectRepoInventory('my-repo', config(), warn)
    expect(inventory?.root).toBe(repo.root)
    expect(inventory?.worktrees).toHaveLength(1)
    const record = inventory!.worktrees[0]
    expect(record).toMatchObject({
      repo: 'my-repo',
      path: worktree,
      branch: 'ABC-1/fix-thing',
      ticket: 'abc-1',
      id: 'abc-1',
      managed: true,
      missing: false,
      base: 'master',
      dirtyFiles: 1,
      ahead: 0,
      behind: 0,
    })
    expect(record.lastCommitAt).toBeGreaterThan(0)
    expect(warned).toEqual([])
  })

  test('a manual worktree outside the convention appears, unmanaged', () => {
    const elsewhere = join(repo.parent, 'somewhere-else')
    repo.git('worktree', 'add', elsewhere, '-b', 'experiment', '--no-track', 'master')

    const inventory = collectRepoInventory('my-repo', config(), warn)
    expect(inventory?.worktrees).toEqual([
      expect.objectContaining({ path: elsewhere, branch: 'experiment', ticket: '', id: 'experiment', managed: false }),
    ])
  })

  test('a worktree whose directory was deleted by hand reads as missing, without git facts', () => {
    const worktree = join(repo.parent, 'my-repo-abc-2')
    repo.git('worktree', 'add', worktree, '-b', 'ABC-2/fix', '--no-track', 'master')
    rmSync(worktree, { recursive: true, force: true })

    const inventory = collectRepoInventory('my-repo', config(), warn)
    expect(inventory?.worktrees).toHaveLength(1)
    const record = inventory!.worktrees[0]
    expect(record).toMatchObject({ path: worktree, missing: true })
    expect(record.dirtyFiles).toBeUndefined()
    expect(record.lastCommitAt).toBeUndefined()
  })

  test('a directory that stopped being a checkout degrades to a fact-less row with a warning', () => {
    const worktree = join(repo.parent, 'my-repo-abc-3')
    repo.git('worktree', 'add', worktree, '-b', 'ABC-3/fix', '--no-track', 'master')
    // The dir still exists but no longer answers as a checkout.
    rmSync(join(worktree, '.git'), { force: true })

    const inventory = collectRepoInventory('my-repo', config(), warn)
    expect(inventory?.worktrees).toHaveLength(1)
    const record = inventory!.worktrees[0]
    expect(record.missing).toBe(false)
    expect(record.dirtyFiles).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(`could not read ${worktree}`)
  })

  test('a broken worktree_dir template warns once and reads as unmanaged', () => {
    repo.git('worktree', 'add', join(repo.parent, 'my-repo-abc-4'), '-b', 'ABC-4/fix', '--no-track', 'master')
    repo.git('worktree', 'add', join(repo.parent, 'my-repo-abc-5'), '-b', 'ABC-5/fix', '--no-track', 'master')

    const inventory = collectRepoInventory('my-repo', config({ worktree_dir: '../{wortkree}' }), warn)
    expect(inventory?.worktrees.map((record) => record.managed)).toEqual([false, false])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('cannot derive the worktree_dir convention')
  })

  test('a repo with no linked worktrees is an empty list, not an error', () => {
    expect(collectRepoInventory('my-repo', config(), warn)?.worktrees).toEqual([])
  })

  test('a root that is not a repo is skipped with a warning', () => {
    const inventory = collectRepoInventory('gone', { root: join(repo.parent, 'gone') }, warn)
    expect(inventory).toBeUndefined()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('skipping gone')
  })
})

describe('attachTabFacts', () => {
  const inventory: RepoInventory = {
    name: 'my-repo',
    root: '/repos/my-repo',
    worktrees: [
      {
        repo: 'my-repo',
        path: '/repos/my-repo-abc-1',
        branch: 'ABC-1/fix',
        ticket: 'abc-1',
        id: 'abc-1',
        managed: true,
        missing: false,
        base: 'origin/master',
      },
    ],
  }

  test('a pane in the worktree ties it to its tab, the agent pane names the agent', () => {
    const attached = attachTabFacts(inventory, [
      { tabId: 't1', cwd: '/repos/my-repo-abc-1' },
      { tabId: 't1', cwd: '/repos/my-repo-abc-1/services/web', agent: 'claude', agentStatus: 'idle' },
      { tabId: 't9', cwd: '/repos/other' },
    ])
    expect(attached.worktrees[0].tab).toEqual({ tabId: 't1', agent: 'claude', agentStatus: 'idle' })
  })

  test('a sibling path sharing the prefix does not match', () => {
    const attached = attachTabFacts(inventory, [{ tabId: 't1', cwd: '/repos/my-repo-abc-10' }])
    expect(attached.worktrees[0].tab).toBeUndefined()
  })

  test('no panes leaves the record untouched', () => {
    expect(attachTabFacts(inventory, []).worktrees[0].tab).toBeUndefined()
  })
})

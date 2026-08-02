import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addWorktree, findWorktreeForBranch, inspectCheckout, listWorktrees, removeWorktree, worktreeFacts } from './git.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'

// These behaviours used to be reachable only through the commands; now the git
// module answers for them at its own interface, against real repos.

let repo: TempRepo
let warned: string[]

const warn = (message: string) => warned.push(message)

const addLinkedWorktree = (name = 'my-repo-abc-1', branch = 'ABC-1/fix') => {
  const worktree = join(repo.parent, name)
  repo.git('worktree', 'add', worktree, '-b', branch, '--no-track', 'master')
  return worktree
}

beforeEach(() => {
  repo = createTempRepo('my-repo')
  warned = []
})

afterEach(() => {
  repo.cleanup()
})

describe('inspectCheckout', () => {
  test('a main checkout is its own main root and is not linked', () => {
    const checkout = inspectCheckout(repo.root)
    expect(checkout).toEqual({ root: repo.root, mainRoot: repo.root, isLinked: false, dirtyFiles: [] })
  })

  test('a linked worktree knows its own root and the main root', () => {
    const worktree = addLinkedWorktree()
    const checkout = inspectCheckout(worktree)
    expect(checkout.root).toBe(worktree)
    expect(checkout.mainRoot).toBe(repo.root)
    expect(checkout.isLinked).toBe(true)
  })

  test('asking from a subdirectory resolves the same roots', () => {
    const worktree = addLinkedWorktree()
    const subdir = join(worktree, 'services', 'web')
    mkdirSync(subdir, { recursive: true })
    const checkout = inspectCheckout(subdir)
    expect(checkout.root).toBe(worktree)
    expect(checkout.mainRoot).toBe(repo.root)
  })

  test('uncommitted changes are listed; a clean tree is empty', () => {
    const worktree = addLinkedWorktree()
    expect(inspectCheckout(worktree).dirtyFiles).toEqual([])
    writeFileSync(join(worktree, 'dirty.txt'), 'wip')
    expect(inspectCheckout(worktree).dirtyFiles).toEqual(['?? dirty.txt'])
  })

  test('a path that is not there reports the git failure, not a TypeError', () => {
    // The worktree.created hook can be handed a directory that was removed
    // between the event and the hook; the spawn never reaches git then.
    expect(() => inspectCheckout(join(repo.parent, 'gone'))).toThrow('failed in')
  })
})

describe('addWorktree', () => {
  test('a new branch is created from the base, without an upstream', () => {
    const worktree = join(repo.parent, 'my-repo-abc-2')
    addWorktree(repo.root, { path: worktree, branch: 'ABC-2/fix', base: 'master', warn })
    expect(existsSync(worktree)).toBe(true)
    expect(repo.git('branch', '--list', 'ABC-2/fix')).toContain('ABC-2/fix')
    // --no-track pinned: a bare `git push` in the worktree must never target
    // the base branch, so the new branch has no upstream configured.
    const upstream = spawnSync('git', ['config', 'branch.ABC-2/fix.merge'], { cwd: repo.root })
    expect(upstream.status).not.toBe(0)
    // A local base has nothing to fetch, so nothing to warn about either.
    expect(warned).toEqual([])
  })

  test('an existing branch is reused as-is', () => {
    repo.git('branch', 'ABC-3/fix')
    const worktree = join(repo.parent, 'my-repo-abc-3')
    addWorktree(repo.root, { path: worktree, branch: 'ABC-3/fix', base: 'master', warn })
    expect(existsSync(worktree)).toBe(true)
  })

  test('a remote-tracking base that cannot be fetched warns and branches from the local ref', () => {
    // The offline case: origin exists in config but is unreachable, while the
    // remote-tracking ref is present from an earlier fetch.
    repo.git('remote', 'add', 'origin', join(repo.parent, 'nowhere'))
    repo.git('update-ref', 'refs/remotes/origin/master', 'master')
    const worktree = join(repo.parent, 'my-repo-abc-4')
    addWorktree(repo.root, { path: worktree, branch: 'ABC-4/fix', base: 'origin/master', warn })
    expect(existsSync(worktree)).toBe(true)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('could not fetch origin/master, branching from the local ref')
  })

  test('a reachable remote base is refreshed before branching', () => {
    // A clone whose origin has moved on: without the fetch, the new branch
    // would fork from the stale remote-tracking ref.
    const clone = join(repo.parent, 'clone')
    const run = (cwd: string, args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
      return result.stdout.trim()
    }
    run(repo.parent, ['clone', '--quiet', repo.root, clone])
    writeFileSync(join(repo.root, 'newer.txt'), 'newer')
    repo.git('add', '.')
    repo.git('commit', '-m', 'newer')
    const upstreamHead = repo.git('rev-parse', 'HEAD')

    const worktree = join(repo.parent, 'clone-abc-5')
    addWorktree(clone, { path: worktree, branch: 'ABC-5/fix', base: 'origin/master', warn })
    expect(run(worktree, ['rev-parse', 'HEAD'])).toBe(upstreamHead)
    expect(warned).toEqual([])
  })
})

describe('listWorktrees', () => {
  test('the main checkout is first and marked, linked worktrees carry their branch', () => {
    const worktree = addLinkedWorktree()
    expect(listWorktrees(repo.root)).toEqual([
      { path: repo.root, branch: 'master', isMain: true },
      { path: worktree, branch: 'ABC-1/fix', isMain: false },
    ])
  })

  test('asking from a linked worktree lists the same set', () => {
    const worktree = addLinkedWorktree()
    expect(listWorktrees(worktree)).toEqual(listWorktrees(repo.root))
  })

  test('a path with spaces survives the parse', () => {
    const worktree = join(repo.parent, 'my repo abc 9')
    repo.git('worktree', 'add', worktree, '-b', 'ABC-9/fix', '--no-track', 'master')
    expect(listWorktrees(repo.root).map((listing) => listing.path)).toContain(worktree)
  })

  test('a detached worktree has no branch', () => {
    const worktree = join(repo.parent, 'my-repo-detached')
    repo.git('worktree', 'add', '--detach', worktree, 'master')
    const detached = listWorktrees(repo.root).find((listing) => listing.path === worktree)
    expect(detached).toEqual({ path: worktree, branch: undefined, isMain: false })
  })
})

describe('findWorktreeForBranch', () => {
  test('finds the worktree holding a branch, wherever it happens to live', () => {
    // The naming convention says nothing here: this path matches no
    // worktree_dir template, which is exactly the case that used to be missed.
    const worktree = join(repo.parent, 'somewhere-else-entirely')
    repo.git('worktree', 'add', worktree, '-b', 'ui/upgrade', '--no-track', 'master')
    expect(findWorktreeForBranch(repo.root, 'ui/upgrade')).toEqual({
      path: worktree,
      branch: 'ui/upgrade',
      isMain: false,
    })
  })

  test('reports the main checkout as such rather than hiding it', () => {
    expect(findWorktreeForBranch(repo.root, 'master')).toEqual({
      path: repo.root,
      branch: 'master',
      isMain: true,
    })
  })

  test('a branch that is not checked out anywhere is undefined', () => {
    repo.git('branch', 'ABC-2/not-checked-out')
    expect(findWorktreeForBranch(repo.root, 'ABC-2/not-checked-out')).toBeUndefined()
    expect(findWorktreeForBranch(repo.root, 'no-such-branch')).toBeUndefined()
  })
})

describe('worktreeFacts', () => {
  test('a fresh worktree is clean, dated, and even with its base', () => {
    const worktree = addLinkedWorktree()
    const facts = worktreeFacts(worktree, 'master')
    expect(facts.dirtyFiles).toBe(0)
    expect(facts.lastCommitAt).toBeGreaterThan(0)
    expect(facts.ahead).toBe(0)
    expect(facts.behind).toBe(0)
  })

  test('dirty files are counted, commits move ahead, base commits count as behind', () => {
    const worktree = addLinkedWorktree()
    const run = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
    writeFileSync(join(worktree, 'done.txt'), 'done')
    run(['add', 'done.txt'])
    run(['commit', '-m', 'ahead'])
    writeFileSync(join(worktree, 'a.txt'), 'wip')
    writeFileSync(join(worktree, 'b.txt'), 'wip')
    // The base moves on independently.
    writeFileSync(join(repo.root, 'base.txt'), 'base')
    repo.git('add', '.')
    repo.git('commit', '-m', 'base moved')

    const facts = worktreeFacts(worktree, 'master')
    expect(facts.dirtyFiles).toBe(2)
    expect(facts.ahead).toBe(1)
    expect(facts.behind).toBe(1)
  })

  test('an unresolvable base reads as unknown, not as 0/0', () => {
    const worktree = addLinkedWorktree()
    const facts = worktreeFacts(worktree, 'origin/never-fetched')
    expect(facts.ahead).toBeUndefined()
    expect(facts.behind).toBeUndefined()
    expect(facts.dirtyFiles).toBe(0)
  })
})

describe('removeWorktree', () => {
  test('removes a clean worktree', () => {
    const worktree = addLinkedWorktree()
    removeWorktree(repo.root, worktree)
    expect(existsSync(worktree)).toBe(false)
  })

  test('a dirty worktree survives: the module never reaches for --force', () => {
    // `down` refuses dirty worktrees with its own message first; this pins the
    // backstop underneath, so no future caller can force past git's refusal.
    const worktree = addLinkedWorktree()
    writeFileSync(join(worktree, 'dirty.txt'), 'wip')
    expect(() => removeWorktree(repo.root, worktree)).toThrow(/force/)
    expect(existsSync(join(worktree, 'dirty.txt'))).toBe(true)
  })
})

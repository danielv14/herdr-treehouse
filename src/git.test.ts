import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addWorktree, inspectCheckout, removeWorktree } from './git.ts'
import { createTempRepo, type TempRepo } from './testing/tempRepo.ts'

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

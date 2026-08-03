import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

// The one place that knows git: argv, ref shapes, and the flags that must NOT
// be there. No raw git argv appears outside this module.

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  // A spawn that never reached git (a cwd that does not exist, which the
  // worktree.created hook can be handed) leaves status and both streams null,
  // so reading stderr first replaced the real reason with a TypeError.
  if (result.error) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

// The main checkout is always the first entry in `git worktree list`.
export const findMainRepoRoot = (cwd: string): string => {
  const porcelain = git(cwd, ['worktree', 'list', '--porcelain'])
  const firstLine = porcelain.split('\n')[0] ?? ''
  const mainRoot = firstLine.replace(/^worktree /, '')
  if (!mainRoot) throw new Error(`could not resolve main worktree from ${cwd}`)
  return mainRoot
}

export type Checkout = {
  // Toplevel of the checkout `path` is inside: the worktree root when linked,
  // the main root otherwise.
  root: string
  mainRoot: string
  isLinked: boolean
  // `status --porcelain` lines; empty means clean.
  dirtyFiles: string[]
}

export const inspectCheckout = (path: string): Checkout => {
  const root = git(path, ['rev-parse', '--show-toplevel'])
  const mainRoot = findMainRepoRoot(path)
  const status = git(root, ['status', '--porcelain'])
  return {
    root,
    mainRoot,
    isLinked: root !== mainRoot,
    dirtyFiles: status === '' ? [] : status.split('\n'),
  }
}

export type WorktreeListing = {
  path: string
  // Short branch name; undefined when the checkout is detached or bare.
  branch?: string
  isMain: boolean
}

// `--porcelain -z`: attribute lines end in NUL, records are separated by an
// extra NUL, so paths with spaces or newlines survive.
export const listWorktrees = (root: string): WorktreeListing[] =>
  git(root, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0\0')
    .filter((record) => record !== '')
    .map((record, index) => {
      const lines = record.split('\0').filter((line) => line !== '')
      const attribute = (name: string) =>
        lines.find((line) => line === name || line.startsWith(`${name} `))?.slice(name.length + 1)
      const branchRef = attribute('branch')
      return {
        path: attribute('worktree') ?? '',
        branch: branchRef?.replace(/^refs\/heads\//, ''),
        isMain: index === 0,
      }
    })
    .filter((listing) => listing.path !== '')

// Where a branch is checked out, if anywhere. The main checkout is included so
// the caller can tell "on your desk, not in a worktree" apart from "nowhere".
// Why `up` must ask this before deriving a path: docs/worktree-lifecycle.md.
export const findWorktreeForBranch = (
  root: string,
  branch: string,
): WorktreeListing | undefined =>
  listWorktrees(root).find((listing) => listing.branch === branch)

// realpath levels symlinks like macOS /var vs /private/var, which git resolves
// and a path built from a template does not. A path that does not exist
// compares as written, which is what a not-yet-created worktree needs.
export const samePath = (a: string, b: string): boolean => {
  const canonical = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  return canonical(a) === canonical(b)
}

// Which worktree, if any, sits at a path. Answered from git rather than
// existsSync: the directory being there says nothing about whose branch is
// checked out in it.
export const findWorktreeAtPath = (root: string, path: string): WorktreeListing | undefined =>
  listWorktrees(root).find((listing) => samePath(listing.path, path))

export const countLinkedWorktrees = (root: string): number =>
  listWorktrees(root).filter((listing) => !listing.isMain).length

export type WorktreeFacts = {
  // Number of `status --porcelain` lines; 0 means clean.
  dirtyFiles: number
  // Unix seconds of the checked-out HEAD's commit; undefined on an unborn HEAD.
  lastCommitAt?: number
  // Commits on the worktree's HEAD that the base does not have, and vice versa.
  // Both undefined when the base ref cannot be resolved (never fetched, gone).
  ahead?: number
  behind?: number
}

// Read-only and offline on purpose: no fetch, so ahead/behind is against the
// base as last fetched.
export const worktreeFacts = (worktreePath: string, base: string): WorktreeFacts => {
  const status = git(worktreePath, ['status', '--porcelain'])
  const facts: WorktreeFacts = {
    dirtyFiles: status === '' ? 0 : status.split('\n').length,
  }
  try {
    const seconds = Number(git(worktreePath, ['log', '-1', '--format=%ct']))
    if (Number.isFinite(seconds)) facts.lastCommitAt = seconds
  } catch {
    // An unborn HEAD has no commit to date.
  }
  try {
    const counts = git(worktreePath, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
    const [behind, ahead] = counts.split(/\s+/).map(Number)
    facts.behind = behind
    facts.ahead = ahead
  } catch {
    // The base ref does not resolve here (never fetched, or deleted); an
    // unknown distance must read as unknown, not as 0/0.
  }
  return facts
}

const branchExists = (repoRoot: string, branch: string): boolean => {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoRoot,
  })
  return result.status === 0
}

export type AddWorktreeRequest = {
  path: string
  branch: string
  base: string
  warn: (message: string) => void
}

// An existing branch is reused as-is; a new one branches from `base`, fetching
// the remote side of a remote-tracking base first so it does not fork from a
// stale fetch (offline is survivable: warn and branch from the local ref).
// --no-track, so a bare `git push` in the worktree can never target the base.
export const addWorktree = (root: string, request: AddWorktreeRequest) => {
  if (branchExists(root, request.branch)) {
    git(root, ['worktree', 'add', request.path, request.branch])
    return
  }
  const remote = request.base.match(/^([^/]+)\/(.+)$/)
  if (remote) {
    try {
      git(root, ['fetch', remote[1], remote[2]])
    } catch (error) {
      request.warn(
        `warning: could not fetch ${request.base}, branching from the local ref (${error instanceof Error ? error.message : error})`,
      )
    }
  }
  git(root, ['worktree', 'add', request.path, '-b', request.branch, '--no-track', request.base])
}

// Never --force: refusing on dirt is the safety property `down` promises, and
// git.test.ts pins that a dirty worktree survives this call.
export const removeWorktree = (root: string, worktreePath: string) => {
  git(root, ['worktree', 'remove', worktreePath])
}

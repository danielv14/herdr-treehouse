import { spawnSync } from 'node:child_process'

// The one place that knows git, the way tabs.ts is the one place that knows
// Herdr: argv, ref shapes, and the flags that must NOT be there. Commands ask
// questions (inspectCheckout) and name intents (addWorktree, removeWorktree);
// no raw git argv appears outside this module.

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

// Everything a teardown needs to know about a checkout, in one call.
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
  // The main checkout: first entry in `git worktree list`.
  isMain: boolean
}

// Every worktree of the repo, from `git worktree list --porcelain -z`: the
// machine-readable contract, NUL-terminated so paths with spaces or newlines
// survive. Each record is attribute lines ending in NUL, records separated by
// an extra NUL.
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

// How many linked worktrees the repo has; the value behind the sidebar's
// worktree-count token.
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

// The listing facts about one worktree, in one call. Read-only and offline on
// purpose: no fetch, so ahead/behind is against the base as last fetched, and
// asking never mutates anything.
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

// Create the worktree for `branch`. An existing branch is reused as-is; a new
// one branches from `base`, fetching the remote side of a remote-tracking base
// first so it does not fork from a stale fetch. Offline is survivable: warn and
// branch from the local ref. --no-track, so a bare `git push` in the worktree
// can never target the base branch.
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

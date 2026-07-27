import { spawnSync } from 'node:child_process'

export const git = (cwd: string, args: string[]): string => {
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

export const findRepoRoot = (cwd: string) => git(cwd, ['rev-parse', '--show-toplevel'])

// The main checkout is always the first entry in `git worktree list`.
export const findMainRepoRoot = (cwd: string): string => {
  const porcelain = git(cwd, ['worktree', 'list', '--porcelain'])
  const firstLine = porcelain.split('\n')[0] ?? ''
  const mainRoot = firstLine.replace(/^worktree /, '')
  if (!mainRoot) throw new Error(`could not resolve main worktree from ${cwd}`)
  return mainRoot
}

export const isLinkedWorktree = (cwd: string) => findRepoRoot(cwd) !== findMainRepoRoot(cwd)

export const branchExists = (repoRoot: string, branch: string): boolean => {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoRoot,
  })
  return result.status === 0
}

export const dirtyFiles = (worktreePath: string): string[] => {
  const status = git(worktreePath, ['status', '--porcelain'])
  return status === '' ? [] : status.split('\n')
}

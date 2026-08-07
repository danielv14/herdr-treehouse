import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import type { RepoConfig } from '../config/config.ts'
import { addWorktree, findWorktreeAtPath } from './git.ts'
import type { WorktreePlan } from './plan.ts'

// "Make this worktree exist and be usable", shared by `treehouse up` and the
// worktree.created hook. This unifies invocation, not configuration: `setup`
// and `bootstrap` stay two tiers with two meanings (see CLAUDE.md).

export type ProvisionOptions = {
  // 'just-created' means someone else made the checkout moments ago (Herdr's
  // native flow): nothing to create, but setup must still run.
  worktreeState?: 'unknown' | 'just-created'
  // Run `setup` even though the worktree already exists (`up --setup`). An
  // existing worktree is not necessarily a provisioned one; whether the
  // commands are worth re-running is the caller's call.
  setupExisting?: boolean
  log: (message: string) => void
  warn: (message: string) => void
}

export type ProvisionResult = {
  // True when this run (or the event it reacted to) produced the worktree.
  created: boolean
  setupRan: boolean
}

export const provisionWorktree = (
  plan: WorktreePlan,
  repoConfig: RepoConfig,
  options: ProvisionOptions,
): ProvisionResult => {
  const { log, warn } = options
  const justCreated = options.worktreeState === 'just-created'
  // Whether a worktree is already here is git's question, the way it is in
  // placement.ts: a directory git knows nothing about is not a worktree to
  // reopen, and answering with existsSync opened a tab on it with setup
  // skipped. 'just-created' is exempt because Herdr made the checkout moments
  // ago and it is meant to be provisioned as fresh.
  const existedBefore = justCreated
    ? false
    : findWorktreeAtPath(plan.root, plan.worktree) !== undefined

  // `?.length`, not just presence: `bootstrap = []` is a truthy empty argv, and
  // spawning argv[0] === undefined crashes with a Node type error instead of
  // doing the obvious thing (no bootstrap configured).
  const hasBootstrap = Boolean(repoConfig.bootstrap?.length)

  if (hasBootstrap) {
    // A bootstrap replaces worktree creation entirely. It runs on the hook path
    // too, where the checkout already exists: the rest of what it does is still
    // needed.
    const argv = plan.expandArgv(repoConfig.bootstrap ?? [])
    log(`bootstrap: ${argv.join(' ')}`)
    const result = spawnSync(argv[0], argv.slice(1), { cwd: plan.root, stdio: 'inherit' })
    // A spawn that never reached the script (argv[0] missing, or without its exec
    // bit) leaves status undefined and the reason in `error`, so reading status
    // first reported "exit undefined" and named neither the file nor the reason.
    if (result.error) throw new Error(`bootstrap failed to run ${argv[0]}: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`bootstrap failed (exit ${result.status}): ${argv[0]}`)
  } else if (justCreated) {
    // Herdr already created the checkout; nothing to create here.
  } else if (existedBefore) {
    log(`worktree already exists: ${plan.worktree}`)
  } else {
    if (pathInTheWay(plan.worktree)) {
      throw new Error(
        `${plan.worktree} already holds files, but git has no worktree there: nothing to reopen, and nothing to create into. ` +
          'Move it aside or remove it, or give worktree_dir a path of its own.',
      )
    }
    addWorktree(plan.root, { path: plan.worktree, branch: plan.branch, base: plan.base, warn })
  }

  if (!existsSync(plan.worktree)) {
    throw new Error(
      hasBootstrap
        ? `bootstrap finished but worktree is missing: ${plan.worktree}`
        : `worktree is missing after creation: ${plan.worktree}`,
    )
  }

  // Setup belongs to a fresh worktree: re-running `up` on an existing one must
  // not trigger another npm ci behind your back.
  const setup = repoConfig.setup ?? []
  if (existedBefore && !options.setupExisting) {
    if (setup.length > 0) {
      log('worktree already existed; setup commands skipped (re-run with --setup to run them here)')
    }
    return { created: false, setupRan: false }
  }
  runSetup(plan, setup, log)
  return { created: !existedBefore, setupRan: setup.length > 0 }
}

// Whether something at the path stops git from checking a worktree out into it.
// `git worktree add` takes over an EMPTY directory happily, so only a path with
// files in it is in the way; readdir on a plain file throws, which is in the way
// too. Refusing on mere existence would turn a harmless leftover directory into
// an error for no gain.
const pathInTheWay = (path: string): boolean => {
  if (!existsSync(path)) return false
  try {
    return readdirSync(path).length > 0
  } catch {
    return true
  }
}

// A half-provisioned worktree is worse than none at all, so a failing setup
// command aborts before anything opens a tab on it.
const runSetup = (
  plan: WorktreePlan,
  commands: string[],
  log: (message: string) => void,
) => {
  // Expand the whole list before running any of it: a typo'd placeholder in the
  // second command must stop the run before the first has changed the worktree.
  const expanded = commands.map((rawCommand) => plan.expand(rawCommand, 'setup'))
  for (const command of expanded) {
    log(`setup: ${command}`)
    const result = spawnSync('bash', ['-lc', command], { cwd: plan.worktree, stdio: 'inherit' })
    // bash existing covers argv[0], but not the cwd: a bootstrap that leaves a
    // plain file at the worktree path passes the existsSync check above, and the
    // spawn then fails with no status to report.
    if (result.error) {
      throw new Error(`setup command failed to run in ${plan.worktree}: ${result.error.message}`)
    }
    if (result.status !== 0) throw new Error(`setup command failed (exit ${result.status}): ${command}`)
  }
}

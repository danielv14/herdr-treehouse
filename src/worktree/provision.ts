import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { RepoConfig } from '../config/config.ts'
import { addWorktree } from './git.ts'
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
  const existedBefore = justCreated ? false : existsSync(plan.worktree)

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
    if (result.status !== 0) throw new Error(`bootstrap failed (exit ${result.status})`)
  } else if (justCreated) {
    // Herdr already created the checkout; nothing to create here.
  } else if (existedBefore) {
    log(`worktree already exists: ${plan.worktree}`)
  } else {
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
    if (result.status !== 0) throw new Error(`setup command failed (exit ${result.status}): ${command}`)
  }
}

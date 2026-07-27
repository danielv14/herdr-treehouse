import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { RepoConfig } from './config.ts'
import { branchExists, git } from './git.ts'
import type { WorktreePlan } from './plan.ts'

// One implementation of "make this worktree exist and be usable", shared by
// `treehouse up` and the worktree.created hook, so a repo configured with
// setup = ["npm ci"] and no bootstrap is provisioned by both.
//
// This unifies invocation, not configuration: `setup` and `bootstrap` stay two
// tiers with two meanings (see CLAUDE.md).

export type ProvisionOptions = {
  // 'just-created' means the caller knows the checkout was created moments ago
  // by someone else (Herdr's native worktree flow, before the hook fires): there
  // is nothing to create, but it is still a fresh worktree, so setup must run.
  worktreeState?: 'unknown' | 'just-created'
  // No console default: what provisioning says is the caller's output.
  log: (message: string) => void
  warn: (message: string) => void
}

export type ProvisionResult = {
  // True when this run (or the event it reacted to) produced the worktree, i.e.
  // when it is fresh. False when it was already there.
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
    // A bootstrap replaces worktree creation entirely: it owns branching, env
    // files and dependencies. It runs on the hook path too, where the checkout
    // already exists, because the rest of what it does is still needed.
    const argv = plan.expandArgv(repoConfig.bootstrap ?? [])
    log(`bootstrap: ${argv.join(' ')}`)
    const result = spawnSync(argv[0], argv.slice(1), { cwd: plan.root, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`bootstrap failed (exit ${result.status})`)
  } else if (justCreated) {
    // Herdr already created the checkout; nothing to create here.
  } else if (existedBefore) {
    log(`worktree already exists: ${plan.worktree}`)
  } else {
    createWorktree(plan, warn)
  }

  if (!existsSync(plan.worktree)) {
    throw new Error(
      hasBootstrap
        ? `bootstrap finished but worktree is missing: ${plan.worktree}`
        : `worktree is missing after creation: ${plan.worktree}`,
    )
  }

  // Setup only on a fresh worktree: re-running `up` on an existing one should
  // not trigger another npm ci.
  if (existedBefore) {
    if (repoConfig.setup?.length) {
      log('worktree already existed; setup commands skipped (run them manually if deps are missing)')
    }
    return { created: false, setupRan: false }
  }
  runSetup(plan, repoConfig, log)
  return { created: true, setupRan: (repoConfig.setup?.length ?? 0) > 0 }
}

const createWorktree = (plan: WorktreePlan, warn: (message: string) => void) => {
  if (branchExists(plan.root, plan.branch)) {
    git(plan.root, ['worktree', 'add', plan.worktree, plan.branch])
    return
  }
  // Refresh the base ref so new branches don't silently fork from a stale
  // fetch. Offline is survivable; branching from the local ref then.
  const baseMatch = plan.base.match(/^([^/]+)\/(.+)$/)
  if (baseMatch) {
    try {
      git(plan.root, ['fetch', baseMatch[1], baseMatch[2]])
    } catch (error) {
      warn(
        `warning: could not fetch ${plan.base}, branching from the local ref (${error instanceof Error ? error.message : error})`,
      )
    }
  }
  git(plan.root, ['worktree', 'add', plan.worktree, '-b', plan.branch, '--no-track', plan.base])
}

const runSetup = (
  plan: WorktreePlan,
  repoConfig: RepoConfig,
  log: (message: string) => void,
) => {
  for (const rawCommand of repoConfig.setup ?? []) {
    const command = plan.expand(rawCommand, 'setup')
    log(`setup: ${command}`)
    const result = spawnSync('bash', ['-lc', command], { cwd: plan.worktree, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`setup command failed (exit ${result.status}): ${command}`)
  }
}

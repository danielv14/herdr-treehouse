import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { RepoConfig } from '../config/config.ts'
import { addWorktree } from './git.ts'
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
  // Run `setup` even though the worktree already exists (`treehouse up --setup`).
  // A worktree that exists is not the same as a worktree that was provisioned:
  // it may have been created by hand, by another tool, or by Herdr's own flow in
  // a repo treehouse only learned about afterwards. Whether the commands are
  // worth re-running is the caller's call, not something the engine guesses from
  // the state of the directory.
  setupExisting?: boolean
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
  // not trigger another npm ci behind your back. `--setup` is how the caller says
  // this particular worktree needs it anyway.
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
  // Expand the whole list before running any of it, for the same reason `up`
  // expands pane commands before provisioning: a typo'd placeholder is broken
  // config, and broken config must stop the run before the first command has
  // changed anything. Expanding lazily meant a typo in the second command threw
  // only after the first had spent 30 seconds on npm ci, leaving exactly the
  // half-provisioned worktree that aborting is supposed to prevent.
  const expanded = commands.map((rawCommand) => plan.expand(rawCommand, 'setup'))
  for (const command of expanded) {
    log(`setup: ${command}`)
    const result = spawnSync('bash', ['-lc', command], { cwd: plan.worktree, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`setup command failed (exit ${result.status}): ${command}`)
  }
}

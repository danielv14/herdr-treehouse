import { resolveRepoConfig } from './config.ts'
import type { EngineDeps } from './deps.ts'
import { reportDiagnostics } from './diagnostics.ts'
import { findMainRepoRoot } from './git.ts'
import { buildWorktreePlan } from './plan.ts'
import { provisionWorktree } from './provision.ts'

// Handler for the worktree.created event (Herdr's native worktree flow).
// Event hooks receive the payload in HERDR_PLUGIN_EVENT_JSON; the invocation
// context (HERDR_PLUGIN_CONTEXT_JSON) does NOT carry branch or path. Per
// `herdr api schema`, worktree_created event data is
// { type, workspace: WorkspaceInfo, worktree: WorktreeInfo } where
// WorktreeInfo has `path` and `branch`. Not yet observed live; the raw
// payload is logged (visible via `herdr plugin log list --plugin treehouse`)
// so a real event can confirm the shape.
//
// Everything after decoding the payload is the same provisioning module `up`
// uses, so a repo configured with only `setup` gets its dependencies here too.
export const bootstrapFromEvent = async (deps: EngineDeps) => {
  const log = deps.warn ?? console.error
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON
  if (!raw) {
    log('no HERDR_PLUGIN_EVENT_JSON in environment, nothing to do')
    return
  }
  log(`event payload: ${raw}`)

  const payload = JSON.parse(raw)
  const worktree = payload?.data?.worktree ?? payload?.worktree
  const worktreePath: string | undefined = worktree?.path ?? worktree?.checkout_path
  const branch: string | undefined = worktree?.branch
  if (!worktreePath || !branch) {
    log('could not find worktree path/branch in event payload, skipping bootstrap')
    return
  }

  const mainRepoRoot = findMainRepoRoot(worktreePath)
  const { name: repoName, config: repoConfig, diagnostics } = await resolveRepoConfig(mainRepoRoot, deps.invoke)
  reportDiagnostics(diagnostics, log)
  if (!repoConfig.bootstrap && !repoConfig.setup?.length) {
    log(`no bootstrap or setup configured for ${repoName}, skipping`)
    return
  }

  const plan = buildWorktreePlan({
    repoName,
    branch,
    mainRepoRoot,
    repoConfig,
    // Herdr created the checkout, so its path is a given rather than a
    // worktree_dir question.
    worktree: worktreePath,
  })
  provisionWorktree(plan, repoConfig, { worktreeState: 'just-created', log, warn: log })
}

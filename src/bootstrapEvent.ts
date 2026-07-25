import { spawnSync } from 'node:child_process'
import { buildTemplateContext, expandArgv, resolveRepoConfig, type TemplateContext } from './config.ts'
import { findMainRepoRoot } from './git.ts'

// Handler for the worktree.created event (Herdr's native worktree flow).
// Event hooks receive the payload in HERDR_PLUGIN_EVENT_JSON; the invocation
// context (HERDR_PLUGIN_CONTEXT_JSON) does NOT carry branch or path. Per
// `herdr api schema`, worktree_created event data is
// { type, workspace: WorkspaceInfo, worktree: WorktreeInfo } where
// WorktreeInfo has `path` and `branch`. Not yet observed live; the raw
// payload is logged (visible via `herdr plugin log list --plugin treehouse`)
// so a real event can confirm the shape.
export const bootstrapFromEvent = async () => {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON
  if (!raw) {
    console.error('no HERDR_PLUGIN_EVENT_JSON in environment, nothing to do')
    return
  }
  console.error(`event payload: ${raw}`)

  const payload = JSON.parse(raw)
  const worktree = payload?.data?.worktree ?? payload?.worktree
  const worktreePath: string | undefined = worktree?.path ?? worktree?.checkout_path
  const branch: string | undefined = worktree?.branch
  if (!worktreePath || !branch) {
    console.error('could not find worktree path/branch in event payload, skipping bootstrap')
    return
  }

  const mainRepoRoot = findMainRepoRoot(worktreePath)
  const { name: repoName, config: repoConfig } = await resolveRepoConfig(mainRepoRoot)
  if (!repoConfig.bootstrap) {
    console.error(`no bootstrap configured for ${repoName}, skipping`)
    return
  }

  const base = repoConfig.base ?? 'origin/master'
  const templateContext: TemplateContext = {
    ...buildTemplateContext(repoName, branch, base, [], mainRepoRoot),
    worktree: worktreePath,
  }
  const argv = expandArgv(repoConfig.bootstrap, templateContext)
  console.error(`running bootstrap: ${argv.join(' ')}`)
  const result = spawnSync(argv[0], argv.slice(1), { cwd: mainRepoRoot, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`bootstrap failed (exit ${result.status})`)
}

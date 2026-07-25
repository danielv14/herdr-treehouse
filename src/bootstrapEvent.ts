import { spawnSync } from 'node:child_process'
import { buildTemplateContext, expandArgv, resolveRepoConfig, type TemplateContext } from './config.ts'
import { findMainRepoRoot } from './git.ts'

// Handler for the worktree.created event (Herdr's native worktree flow).
// The context payload shape is not fully documented, so this handler is
// deliberately defensive: it logs what it receives (visible via
// `herdr plugin log list --plugin treehouse`) and only acts when it can find
// a worktree path and branch.
export const bootstrapFromEvent = async () => {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON
  if (!raw) {
    console.error('no HERDR_PLUGIN_CONTEXT_JSON in environment, nothing to do')
    return
  }
  console.error(`event context: ${raw}`)

  const context = JSON.parse(raw)
  const worktreePath: string | undefined =
    context?.worktree?.path ?? context?.worktree?.checkout_path
  const branch: string | undefined = context?.worktree?.branch
  if (!worktreePath || !branch) {
    console.error('could not find worktree path/branch in event context, skipping bootstrap')
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

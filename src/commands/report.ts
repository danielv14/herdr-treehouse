import { parseFlags, type CommandSpec } from '../cli.ts'
import { resolveAllRepoConfigs } from '../config/config.ts'
import { resolveDeps, type EngineDeps, type ResolvedDeps } from '../deps.ts'
import { listWorktrees } from '../worktree/git.ts'

export const REPORT_COMMAND: CommandSpec = {
  name: 'report',
  usage: ['treehouse report'],
  summary: 'report sidebar metadata tokens to Herdr (worktree count per repo workspace)',
  notes: [
    'Call site for the manifest hooks (worktree.created/removed, startup); Herdr does not',
    'persist reported tokens across a server restart, so startup re-reports them.',
  ],
  flags: [],
}

// The one token this plugin reports in v1: how many linked worktrees the
// workspace's repo has. Consumed from the user's own sidebar config as
// $worktrees (see README).
export const WORKTREES_TOKEN = 'worktrees'

// Refresh the token for one repo, straight after the engine itself changed the
// count (up created a worktree, down removed one). Herdr's worktree events only
// cover its own native flow, so the engine reports at its own points of change.
// Best-effort on purpose: a failed report must never fail the command that did
// the real work.
export const refreshWorktreeCount = (
  deps: Pick<ResolvedDeps, 'tabs' | 'warn'>,
  mainRepoRoot: string,
  workspaceId: string,
) => {
  try {
    const count = listWorktrees(mainRepoRoot).filter((listing) => !listing.isMain).length
    deps.tabs.reportWorkspaceMetadata({
      workspaceId,
      tokens: { [WORKTREES_TOKEN]: String(count) },
    })
  } catch (error) {
    deps.warn(
      `warning: could not report the worktree count: ${error instanceof Error ? error.message : error}`,
    )
  }
}

export const report = async (argv: string[], deps: EngineDeps) => {
  const { tabs, insideHerdr, log, warn, pluginConfigDir } = resolveDeps(deps)
  parseFlags(REPORT_COMMAND, argv)
  if (!insideHerdr) throw new Error('not inside a Herdr session (HERDR_ENV != 1)')

  for (const { name, config } of await resolveAllRepoConfigs(pluginConfigDir(), warn)) {
    // Per repo, degrading: one unreadable repo (not cloned here, workspace
    // lookup hiccup) must not stop the tokens of the others.
    try {
      const workspaceId = tabs.findWorkspace(config.root)
      if (!workspaceId) continue
      const count = listWorktrees(config.root).filter((listing) => !listing.isMain).length
      tabs.reportWorkspaceMetadata({ workspaceId, tokens: { [WORKTREES_TOKEN]: String(count) } })
      log(`${name}: ${WORKTREES_TOKEN}=${count} (workspace ${workspaceId})`)
    } catch (error) {
      warn(`warning: skipping ${name}: ${error instanceof Error ? error.message : error}`)
    }
  }
}

import { parseFlags, type CommandSpec } from '../cli.ts'
import { resolveAllRepoConfigs } from '../config/config.ts'
import { WORKTREES_TOKEN } from '../herdr/tabs.ts'
import { resolveDeps, type EngineDeps } from '../deps.ts'
import { countLinkedWorktrees } from '../worktree/git.ts'

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
      const count = countLinkedWorktrees(config.root)
      tabs.reportWorktreeCount(workspaceId, count)
      log(`${name}: ${WORKTREES_TOKEN}=${count} (workspace ${workspaceId})`)
    } catch (error) {
      warn(`warning: skipping ${name}: ${error instanceof Error ? error.message : error}`)
    }
  }
}

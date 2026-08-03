import type { TabChoreography } from './herdr/tabs.ts'
import { countLinkedWorktrees } from './worktree/git.ts'

// Recount from git and push the sidebar token. Lives at the shell level because
// it needs both sides and neither folder may import the other.
// A failed report never fails the command that changed the count: the token is
// a sidebar decoration, and Herdr's own [[startup]] hook re-reports it anyway.
export const refreshWorktreeCount = (
  tabs: Pick<TabChoreography, 'reportWorktreeCount'>,
  workspaceId: string,
  mainRepoRoot: string,
  warn: (message: string) => void,
) => {
  try {
    tabs.reportWorktreeCount(workspaceId, countLinkedWorktrees(mainRepoRoot))
  } catch (error) {
    warn(`warning: could not report the worktree count: ${error instanceof Error ? error.message : error}`)
  }
}

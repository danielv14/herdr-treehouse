import { existsSync } from 'node:fs'
import { slugFromBranch, ticketFromBranch } from './branch.ts'
import { DEFAULT_BASE, type RepoConfig } from '../config/config.ts'
import { listWorktrees, samePath, worktreeFacts } from './git.ts'
import { worktreePlacements, type WorktreePlacement } from './plan.ts'

// One record per linked worktree of a configured repo, assembled from git facts
// and the repo's config. Assembles and returns; rendering is the ls command's
// job and acting on records is prune's (#27). Herdr facts arrive as plain data
// through attachTabFacts below, so this module never knows Herdr.

export type WorktreeTab = {
  tabId: string
  // Herdr's agent detection for the worktree's panes; both absent when the tab
  // has no registered agent.
  agent?: string
  agentStatus?: string
}

export type InventoryWorktree = {
  repo: string
  path: string
  // Undefined when detached.
  branch?: string
  // Ticket parsed from the branch ('' when the branch has none) and the short
  // name this worktree goes by: the ticket, the slug when a second branch of
  // the same ticket made the ticket ambiguous, else the slug.
  ticket: string
  id: string
  // Whether the path is one the repo's worktree_dir convention allows for this
  // branch; a manual `git worktree add` elsewhere still appears, unmanaged.
  managed: boolean
  // The directory is gone but git still lists it (removed by hand; prunable).
  missing: boolean
  base: string
  dirtyFiles?: number
  ahead?: number
  behind?: number
  lastCommitAt?: number
  tab?: WorktreeTab
}

export type RepoInventory = {
  name: string
  // The main checkout root as git reports it (realpathed), which is what tab
  // cwds and worktree paths compare against.
  root: string
  worktrees: InventoryWorktree[]
}

export const collectRepoInventory = (
  name: string,
  config: RepoConfig,
  warn: (message: string) => void,
): RepoInventory | undefined => {
  let listings
  try {
    listings = listWorktrees(config.root)
  } catch (error) {
    warn(`warning: skipping ${name}: ${error instanceof Error ? error.message : error}`)
    return undefined
  }
  const root = listings.find((listing) => listing.isMain)?.path ?? config.root
  const base = config.base ?? DEFAULT_BASE

  // A broken worktree_dir template throws for every branch alike; one warning
  // says why the whole repo reads as unmanaged.
  let templateWarned = false
  // Which of the branch's legal spots this worktree is standing on, if any.
  // Asking for the whole set rather than one derived path is what keeps the
  // slug path of a second branch under the same ticket from reading as an
  // off-convention worktree, and it names the worktree the way `up` named it.
  const placementOf = (branch: string, path: string): WorktreePlacement | undefined => {
    try {
      return worktreePlacements({ repoName: name, branch, mainRepoRoot: root, repoConfig: config }).find(
        (placement) => samePath(placement.worktree, path),
      )
    } catch (error) {
      if (!templateWarned) {
        templateWarned = true
        warn(`warning: ${name}: cannot derive the worktree_dir convention: ${error instanceof Error ? error.message : error}`)
      }
      return undefined
    }
  }

  const worktrees = listings
    .filter((listing) => !listing.isMain)
    .map((listing): InventoryWorktree => {
      const { path, branch } = listing
      const missing = !existsSync(path)
      // A directory that exists but no longer answers as a checkout (.git file
      // gone, unreadable, dubious ownership) degrades to a fact-less row; one
      // broken worktree must not blank the whole listing.
      let facts
      if (!missing) {
        try {
          facts = worktreeFacts(path, base)
        } catch (error) {
          warn(`warning: could not read ${path}: ${error instanceof Error ? error.message : error}`)
        }
      }
      const placement = branch ? placementOf(branch, path) : undefined
      const ticket = branch ? ticketFromBranch(branch) : ''
      return {
        repo: name,
        path,
        branch,
        ticket,
        id: placement?.id ?? (branch ? ticket || slugFromBranch(branch) : ''),
        managed: placement !== undefined,
        missing,
        base,
        ...(facts ?? {}),
      }
    })

  return { name, root, worktrees }
}

export type PaneFacts = {
  tabId: string
  cwd?: string
  agent?: string
  agentStatus?: string
}

// Pure merge of Herdr pane facts (fetched per workspace by the caller) into a
// repo's records: a pane whose cwd sits in a worktree ties that worktree to its
// tab, and the first agent-bearing pane names the agent. A worktree spanning
// several tabs shows the agent's tab (that is the one to go to), falling back
// to the first pane's.
export const attachTabFacts = (inventory: RepoInventory, panes: PaneFacts[]): RepoInventory => ({
  ...inventory,
  worktrees: inventory.worktrees.map((worktree) => {
    const prefix = worktree.path.endsWith('/') ? worktree.path : `${worktree.path}/`
    const mine = panes.filter((pane) => pane.cwd === worktree.path || pane.cwd?.startsWith(prefix))
    if (mine.length === 0) return worktree
    const agentPane = mine.find((pane) => pane.agent)
    return {
      ...worktree,
      tab: {
        tabId: (agentPane ?? mine[0]).tabId,
        agent: agentPane?.agent,
        agentStatus: agentPane?.agentStatus,
      },
    }
  }),
})

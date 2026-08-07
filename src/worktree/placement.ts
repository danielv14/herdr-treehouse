import { findWorktreeAtPath, findWorktreeForBranch, samePath } from './git.ts'
import { conventionalId, worktreePlacements, type PlacementInput } from './plan.ts'

// Where a branch's worktree goes, and whether it is already there. plan.ts
// derives the spots the convention allows one branch and stays pure; this is
// the half that asks git which of them the branch actually gets, so no caller
// assembles the rule out of both. Background: docs/worktree-lifecycle.md.

export type ResolvedPlacement = {
  // What this worktree goes by: {id}, the tab label, the context file name.
  id: string
  worktree: string
  // Whether the path is one the convention allows this branch. A worktree
  // another tool put elsewhere keeps its own path and reads as unmanaged.
  managed: boolean
}

// A worktree with no placement to read a name off: it stands somewhere the
// convention would never derive, or the convention cannot be derived at all
// (a worktree_dir too broken to expand, which `up` refuses on and `ls` renders
// anyway). The branch still has its plain short name.
export const unplaceable = (branch: string, worktree: string): ResolvedPlacement => ({
  id: conventionalId(branch),
  worktree,
  managed: false,
})

export const resolveWorktreePlacement = (request: PlacementInput): ResolvedPlacement => {
  // Git decides where an existing worktree is, not worktree_dir: the convention
  // only describes the worktrees treehouse made. The main checkout is part of
  // git's answer so "on your desk, not in a worktree" is refused explicitly
  // instead of reading as "nowhere".
  const checkedOutAt = findWorktreeForBranch(request.mainRepoRoot, request.branch)
  if (checkedOutAt?.isMain) {
    throw new Error(
      `${request.branch} is checked out in the main checkout (${request.mainRepoRoot}), not in a worktree. Switch it there, or pick another branch.`,
    )
  }
  return checkedOutAt ? placementOfWorktree(request, checkedOutAt.path) : freePlacement(request)
}

// Which of the branch's legal spots a worktree that already exists stands on.
// A caller holding the path already (`ls` walks git's listing) asks this
// directly; `up` reaches it through the resolve above.
export const placementOfWorktree = (
  request: PlacementInput,
  worktree: string,
): ResolvedPlacement => {
  const standingOn = worktreePlacements(request).find((placement) =>
    samePath(placement.worktree, worktree),
  )
  return standingOn
    ? { ...standingOn, managed: true }
    : unplaceable(request.branch, worktree)
}

// Nothing holds the branch yet: the shortest spot no other worktree occupies.
const freePlacement = (request: PlacementInput): ResolvedPlacement => {
  const occupancy = worktreePlacements(request).map((placement) => ({
    placement,
    occupant: findWorktreeAtPath(request.mainRepoRoot, placement.worktree),
  }))
  const free = occupancy.find((entry) => entry.occupant === undefined)
  if (free) return { ...free.placement, managed: true }
  const taken = occupancy
    .map(({ placement, occupant }) => `${placement.worktree} (${occupant?.branch ?? 'detached'})`)
    .join(', ')
  throw new Error(
    `every path worktree_dir derives for ${request.branch} is already a worktree of another branch: ${taken}. ` +
      'Remove one of those worktrees, or give worktree_dir something unique per branch ({slug} or {branch}).',
  )
}

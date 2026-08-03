import { isAbsolute, resolve } from 'node:path'
import { slugFromBranch, ticketFromBranch } from './branch.ts'
import { DEFAULT_BASE, DEFAULT_WORKTREE_DIR, expandHome, type RepoConfig } from '../config/config.ts'

// Everything derived about one worktree, resolved in a single call. Pure: no
// filesystem, no git, no Herdr.

const PLACEHOLDERS = ['repo', 'branch', 'slug', 'ticket', 'id', 'worktree', 'root', 'base'] as const

const TARGETS_PLACEHOLDER = '{targets...}'

// Whether a repo's bootstrap consumes targets; the placeholder itself stays
// private.
export const bootstrapTakesTargets = (repoConfig: RepoConfig): boolean =>
  repoConfig.bootstrap?.includes(TARGETS_PLACEHOLDER) ?? false

export type WorktreePlan = {
  repo: string
  branch: string
  slug: string
  ticket: string
  id: string
  worktree: string
  root: string
  base: string
  targets: string[]
  // Expand placeholders in a single string; `where` only shapes the error message.
  expand: (template: string, where?: string) => string
  // Expand a bootstrap argv: `{targets...}` becomes one entry per target, every
  // other entry gets normal placeholder expansion plus ~ expansion.
  expandArgv: (argv: string[]) => string[]
}

// An unknown placeholder is an error, not a pass-through: a typo used to become
// a literal "{wortkree}" argument that some script then mkdir'd.
//
// Only single-word braces not preceded by `$` are treated as placeholders.
// Config values are shell commands, and braces are ordinary there:
// `docker ps --format '{{.Names}}'`, `kubectl -o jsonpath='{.items[0]}'`,
// `awk '{print $1}'`, `cp ${HOME}/.env .env`. Those must keep passing through
// untouched.
const expandWith = (
  template: string,
  values: Record<string, string>,
  where: string,
): string => {
  if (template.includes(TARGETS_PLACEHOLDER)) {
    throw new Error(
      `${TARGETS_PLACEHOLDER} only expands as a standalone bootstrap argv entry, not in ${where}: ${JSON.stringify(template)}`,
    )
  }
  return template.replace(/(?<!\$)\{(\w+)\}/g, (_whole, key: string) => {
    const value = values[key]
    if (value !== undefined) return value
    if ((PLACEHOLDERS as readonly string[]).includes(key)) {
      throw new Error(`{${key}} is not available in ${where}: ${JSON.stringify(template)}`)
    }
    throw new Error(
      `unknown placeholder {${key}} in ${where}: ${JSON.stringify(template)}. Known placeholders: ${PLACEHOLDERS.map(
        (name) => `{${name}}`,
      ).join(', ')}, plus ${TARGETS_PLACEHOLDER} in bootstrap argv`,
    )
  })
}

export type PlanInput = {
  repoName: string
  branch: string
  mainRepoRoot: string
  repoConfig: RepoConfig
  targets?: string[]
  // Path of a worktree that already exists, when the caller knows it (Herdr's
  // native flow, or a placement picked from worktreePlacements below).
  worktree?: string
  // The short name this worktree goes by, when the caller has picked one from
  // worktreePlacements() rather than taking the convention's default.
  id?: string
}

export type PlacementInput = {
  repoName: string
  branch: string
  mainRepoRoot: string
  repoConfig: RepoConfig
}

// One legal spot for a branch's worktree: a path and the short name that
// derives it. `id` is what {id} expands to and what the tab is labelled with,
// so the two never disagree about which worktree this is.
export type WorktreePlacement = {
  id: string
  worktree: string
}

// The short names one branch can go by, shortest first. A ticket branch has
// two: the ticket id, and the full slug that keeps VKT-1/reducer-approach and
// VKT-1/state-machine-approach apart. Everything else has only the slug.
const idCandidates = (branch: string): string[] => {
  const slug = slugFromBranch(branch)
  const ticket = ticketFromBranch(branch)
  return ticket === '' || ticket === slug ? [slug] : [ticket, slug]
}

// The ordered spots the convention allows one branch; only the caller can ask
// git which are taken. A worktree_dir that ignores {id} yields a single
// placement, so the caller refuses instead of silently reusing another
// branch's worktree. Background: docs/worktree-lifecycle.md.
export const worktreePlacements = (input: PlacementInput): WorktreePlacement[] =>
  idCandidates(input.branch).reduce<WorktreePlacement[]>((placements, id) => {
    const worktree = resolveWorktreePath(
      input.repoConfig,
      input.mainRepoRoot,
      placeholderValues(input, id),
    )
    return placements.some((placement) => placement.worktree === worktree)
      ? placements
      : [...placements, { id, worktree }]
  }, [])

// Every placeholder except {worktree}, which needs the path this feeds into.
const placeholderValues = (input: PlacementInput, id: string): Record<string, string> => ({
  repo: input.repoName,
  branch: input.branch,
  slug: slugFromBranch(input.branch),
  ticket: ticketFromBranch(input.branch),
  id,
  root: input.mainRepoRoot,
  base: input.repoConfig.base ?? DEFAULT_BASE,
})

export const buildWorktreePlan = ({
  repoName,
  branch,
  mainRepoRoot,
  repoConfig,
  targets = [],
  worktree,
  id: chosenId,
}: PlanInput): WorktreePlan => {
  const slug = slugFromBranch(branch)
  const ticket = ticketFromBranch(branch)
  const id = chosenId ?? idCandidates(branch)[0]
  const base = repoConfig.base ?? DEFAULT_BASE

  const withoutWorktree = placeholderValues({ repoName, branch, mainRepoRoot, repoConfig }, id)

  const worktreePath = worktree ?? resolveWorktreePath(repoConfig, mainRepoRoot, withoutWorktree)
  const values: Record<string, string> = { ...withoutWorktree, worktree: worktreePath }

  const expand = (template: string, where = 'a config template') =>
    expandWith(template, values, where)

  return {
    repo: repoName,
    branch,
    slug,
    ticket,
    id,
    worktree: worktreePath,
    root: mainRepoRoot,
    base,
    targets,
    expand,
    expandArgv: (argv) =>
      argv.flatMap((entry) =>
        entry === TARGETS_PLACEHOLDER ? targets : [expandHome(expand(entry, 'bootstrap'))],
      ),
  }
}

// {repo} is the config key, which for unconfigured repos is the directory name;
// set worktree_dir explicitly if a key deliberately differs from it.
const resolveWorktreePath = (
  repoConfig: RepoConfig,
  mainRepoRoot: string,
  values: Record<string, string>,
): string => {
  const template = repoConfig.worktree_dir ?? DEFAULT_WORKTREE_DIR
  const expanded = expandHome(expandWith(template, values, 'worktree_dir'))
  // Relative paths resolve against the main checkout, not the caller's cwd:
  // "../foo" must mean the same thing from a skill, a keybinding and a shell.
  return isAbsolute(expanded) ? expanded : resolve(mainRepoRoot, expanded)
}

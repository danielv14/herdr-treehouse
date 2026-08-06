import { isAbsolute, resolve } from 'node:path'
import { slugFromBranch, ticketFromBranch } from './branch.ts'
import { DEFAULT_BASE, DEFAULT_WORKTREE_DIR, expandHome, type RepoConfig } from '../config/config.ts'

// Everything derived about one worktree, resolved in a single call. Pure: no
// filesystem, no git, no Herdr.

const PLACEHOLDERS = [
  'repo',
  'branch',
  'slug',
  'ticket',
  'id',
  'worktree',
  'root',
  'base',
  'targets',
] as const

const TARGETS_PLACEHOLDER = '{targets...}'

// The prose form of the same list, legal everywhere ordinary placeholders are
// but NOT in bootstrap argv: there it can only be a mistyped {targets...}.
const TARGETS_JOINED_PLACEHOLDER = '{targets}'

// Legal in the agent command and nowhere else. Not in PLACEHOLDERS: only
// expandAgent below can supply a value for it.
const CONTEXT_FILE_PLACEHOLDER = '{context_file}'

// The slot a caller's --model lands in, also agent-command-only. Its value is
// the repo's `model_arg`, which is where the agent's flag spelling lives, so
// the engine never learns that a model is asked for with --model.
const MODEL_ARG_PLACEHOLDER = '{model_arg}'

// Legal inside a model_arg value and nowhere else: it is the one expansion that
// has a model to substitute.
const MODEL_PLACEHOLDER = '{model}'

// Whether a repo's bootstrap consumes targets; the placeholder itself stays
// private.
export const bootstrapTakesTargets = (repoConfig: RepoConfig): boolean =>
  repoConfig.bootstrap?.includes(TARGETS_PLACEHOLDER) ?? false

// Whether an agent command asks for the repo's rendered context.
export const agentCommandTakesContext = (agentCommand: string): boolean =>
  agentCommand.includes(CONTEXT_FILE_PLACEHOLDER)

// Whether an agent command has a slot for a model.
export const agentCommandTakesModel = (agentCommand: string): boolean =>
  agentCommand.includes(MODEL_ARG_PLACEHOLDER)

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
  // Expand an agent command, where `{context_file}` and `{model_arg}` are
  // legal. Both arrive as arguments: only the caller that renders them knows
  // whether there is a file, and whether a model was asked for at all.
  expandAgent: (command: string, values?: AgentValues) => string
  // Expand a `model_arg` value, the one place `{model}` resolves.
  expandModelArg: (template: string, model: string) => string
}

export type AgentValues = {
  contextFile?: string
  // The rendered model fragment, empty when no model was asked for. Empty is a
  // complete answer, not a missing one: the command then reads as it always has.
  modelArg?: string
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
  if (template.includes(CONTEXT_FILE_PLACEHOLDER) && values.context_file === undefined) {
    throw new Error(
      `${CONTEXT_FILE_PLACEHOLDER} only expands in the agent command, not in ${where}: ${JSON.stringify(template)}`,
    )
  }
  if (template.includes(MODEL_ARG_PLACEHOLDER) && values.model_arg === undefined) {
    throw new Error(
      `${MODEL_ARG_PLACEHOLDER} only expands in the agent command, not in ${where}: ${JSON.stringify(template)}`,
    )
  }
  if (template.includes(MODEL_PLACEHOLDER) && values.model === undefined) {
    throw new Error(
      `${MODEL_PLACEHOLDER} only expands inside model_arg, not in ${where}: ${JSON.stringify(template)}. ` +
        `The agent command takes ${MODEL_ARG_PLACEHOLDER}, which model_arg fills in.`,
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
      ).join(', ')}, plus ${TARGETS_PLACEHOLDER} in bootstrap argv, ${CONTEXT_FILE_PLACEHOLDER} and ${MODEL_ARG_PLACEHOLDER} in the agent command, and ${MODEL_PLACEHOLDER} in model_arg`,
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
// two: the ticket id, and the full slug that keeps ABC-1/reducer-approach and
// ABC-1/state-machine-approach apart. Everything else has only the slug.
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
  // {targets} is the prose form of the list {targets...} spreads into bootstrap
  // argv: one string to drop into a sentence, empty when nothing was asked for.
  const values: Record<string, string> = {
    ...withoutWorktree,
    worktree: worktreePath,
    targets: targets.join(', '),
  }

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
      argv.flatMap((entry) => {
        if (entry === TARGETS_PLACEHOLDER) return targets
        if (entry.includes(TARGETS_JOINED_PLACEHOLDER)) {
          throw new Error(
            `${TARGETS_JOINED_PLACEHOLDER} is the comma-separated form, for context and commands; bootstrap argv takes ${TARGETS_PLACEHOLDER} as an entry of its own: ${JSON.stringify(entry)}`,
          )
        }
        return [expandHome(expand(entry, 'bootstrap'))]
      }),
    expandAgent: (command, { contextFile, modelArg } = {}) => {
      const scope = { ...values }
      if (contextFile !== undefined) scope.context_file = contextFile
      if (modelArg !== undefined) scope.model_arg = modelArg
      return expandWith(command, scope, 'the agent command')
    },
    expandModelArg: (template, model) => expandWith(template, { ...values, model }, 'model_arg'),
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

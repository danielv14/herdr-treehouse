import { isAbsolute, resolve } from 'node:path'
import { slugFromBranch, ticketFromBranch } from './branch.ts'
import { expandHome, type RepoConfig } from '../config/config.ts'

const TARGETS_PLACEHOLDER = '{targets...}'

const TARGETS_JOINED_PLACEHOLDER = '{targets}'

const CONTEXT_FILE_PLACEHOLDER = '{context_file}'

const MODEL_ARG_PLACEHOLDER = '{model_arg}'

const BASE_PLACEHOLDERS = ['repo', 'branch', 'slug', 'ticket', 'id', 'root', 'base'] as const

// The placeholders that only mean anything once the worktree path is known.
const WORKTREE_PLACEHOLDERS = [...BASE_PLACEHOLDERS, 'worktree', 'config_dir', 'targets'] as const

// The one rule for which placeholders a template admits: the slot it sits in.
// Not which method a caller picked, not which keys that method merged in, not
// the order of a spread. `worktree_dir` is the base set alone because it is
// what derives {worktree}, and a worktree never belongs in the config dir.
const SLOTS = {
  worktree_dir: { label: 'worktree_dir', admits: BASE_PLACEHOLDERS },
  setup: { label: 'setup', admits: WORKTREE_PLACEHOLDERS },
  pane: { label: 'a pane command', admits: WORKTREE_PLACEHOLDERS },
  bootstrap: { label: 'bootstrap', admits: WORKTREE_PLACEHOLDERS },
  context: { label: 'context', admits: WORKTREE_PLACEHOLDERS },
  agent: {
    label: 'the agent command',
    admits: [...WORKTREE_PLACEHOLDERS, 'context_file', 'model_arg'],
  },
  model_arg: { label: 'model_arg', admits: [...WORKTREE_PLACEHOLDERS, 'model'] },
} as const satisfies Record<string, { label: string; admits: readonly string[] }>

export type TemplateSlot = keyof typeof SLOTS

// The values no slot can derive on its own: the caller that renders one is the
// only one that knows it. Keyed by placeholder name, so the table above is the
// only thing deciding where each may appear.
export type SlotValues = {
  context_file?: string
  // The rendered model fragment, empty when no model was asked for. Empty is a
  // complete answer, not a missing one: the command then reads as it always has.
  model_arg?: string
  model?: string
}

const admits = (slot: TemplateSlot, key: string): boolean =>
  SLOTS[slot].admits.some((name) => name === key)

const slotsAdmitting = (key: string): TemplateSlot[] =>
  (Object.keys(SLOTS) as TemplateSlot[]).filter((slot) => admits(slot, key))

const PLACEHOLDER_HINTS: Record<string, string> = {
  model: `The agent command takes ${MODEL_ARG_PLACEHOLDER}, which model_arg fills in.`,
}

// The one rule for what counts as a placeholder, shared by the expansion below
// and by every question asked about a template: a single word in braces, not
// preceded by `$`. Asking with a plain substring test instead is how
// `${model_arg}` came to read as a slot, which made the "no slot" refusal miss
// and the shell drop the model into an unset variable.
const PLACEHOLDER_PATTERN = /(?<!\$)\{(\w+)\}/g

const usesPlaceholder = (template: string, placeholder: string): boolean =>
  new RegExp(`(?<!\\$)\\{${placeholder.slice(1, -1)}\\}`).test(template)

// Whether a repo's bootstrap consumes targets; the placeholder itself stays
// private. A plain match is right here: the dots in {targets...} are not \w, so
// it is not a placeholder in the sense above and `$` cannot precede it in any
// valid shell.
export const bootstrapTakesTargets = (repoConfig: RepoConfig): boolean =>
  repoConfig.bootstrap?.includes(TARGETS_PLACEHOLDER) ?? false

export const agentCommandTakesContext = (agentCommand: string): boolean =>
  usesPlaceholder(agentCommand, CONTEXT_FILE_PLACEHOLDER)

export const agentCommandTakesModel = (agentCommand: string): boolean =>
  usesPlaceholder(agentCommand, MODEL_ARG_PLACEHOLDER)

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
  // Expand a template for the slot it sits in; the slot decides both what is
  // legal and how a refusal reads. `values` carries what only the caller can
  // supply, and is ignored by slots the table says do not admit it.
  expand: (template: string, slot: TemplateSlot, values?: SlotValues) => string
  // Expand a bootstrap argv: `{targets...}` becomes one entry per target, every
  // other entry gets the bootstrap slot's expansion plus ~ expansion.
  expandArgv: (argv: string[]) => string[]
}

const placeholderError = (key: string, slot: TemplateSlot, template: string): Error => {
  const { label } = SLOTS[slot]
  const where = JSON.stringify(template)
  const elsewhere = slotsAdmitting(key)
  if (elsewhere.length === 0) {
    const known = SLOTS[slot].admits.map((name) => `{${name}}`).join(', ')
    return new Error(
      `unknown placeholder {${key}} in ${label}: ${where}. Placeholders in ${label}: ${known}`,
    )
  }
  // Exactly one slot admitting it makes "where it belongs" a fact of the table,
  // not a second list to keep in step with it.
  if (elsewhere.length === 1) {
    const hint = PLACEHOLDER_HINTS[key]
    return new Error(
      `{${key}} only expands in ${SLOTS[elsewhere[0]].label}, not in ${label}: ${where}` +
        (hint ? `. ${hint}` : ''),
    )
  }
  return new Error(`{${key}} is not available in ${label}: ${where}`)
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
  slot: TemplateSlot,
  derived: Record<string, string>,
  supplied: Record<string, string | undefined>,
): string => {
  const { label } = SLOTS[slot]
  if (template.includes(TARGETS_PLACEHOLDER)) {
    throw new Error(
      `${TARGETS_PLACEHOLDER} only expands as a standalone bootstrap argv entry, not in ${label}: ${JSON.stringify(template)}`,
    )
  }
  // The scope check runs from inside the expansion rather than from a pre-scan,
  // so it answers to PLACEHOLDER_PATTERN like everything else and `${model}` in
  // a setup command stays a shell variable instead of hard-erroring.
  return template.replace(PLACEHOLDER_PATTERN, (_whole, key: string) => {
    if (!admits(slot, key)) throw placeholderError(key, slot, template)
    const value = derived[key] ?? supplied[key]
    if (value === undefined) {
      throw new Error(
        `{${key}} is legal in ${label} but nothing was rendered for it: ${JSON.stringify(template)}`,
      )
    }
    return value
  })
}

export type PlanInput = {
  repoName: string
  branch: string
  mainRepoRoot: string
  repoConfig: RepoConfig
  configDir: string
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

const idCandidates = (branch: string): string[] => {
  const slug = slugFromBranch(branch)
  const ticket = ticketFromBranch(branch)
  return ticket === '' || ticket === slug ? [slug] : [ticket, slug]
}

export const conventionalId = (branch: string): string => idCandidates(branch)[0]

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

const placeholderValues = (input: PlacementInput, id: string): Record<string, string> => ({
  repo: input.repoName,
  branch: input.branch,
  slug: slugFromBranch(input.branch),
  ticket: ticketFromBranch(input.branch),
  id,
  root: input.mainRepoRoot,
  base: input.repoConfig.base,
})

export const buildWorktreePlan = ({
  repoName,
  branch,
  mainRepoRoot,
  repoConfig,
  configDir,
  targets = [],
  worktree,
  id: chosenId,
}: PlanInput): WorktreePlan => {
  const slug = slugFromBranch(branch)
  const ticket = ticketFromBranch(branch)
  const id = chosenId ?? conventionalId(branch)
  const base = repoConfig.base

  const withoutWorktree = placeholderValues({ repoName, branch, mainRepoRoot, repoConfig }, id)

  const worktreePath = worktree ?? resolveWorktreePath(repoConfig, mainRepoRoot, withoutWorktree)
  const values: Record<string, string> = {
    ...withoutWorktree,
    worktree: worktreePath,
    config_dir: configDir,
    targets: targets.join(', '),
  }

  const expand = (template: string, slot: TemplateSlot, supplied: SlotValues = {}) =>
    expandWith(template, slot, values, supplied)

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
        if (usesPlaceholder(entry, TARGETS_JOINED_PLACEHOLDER)) {
          throw new Error(
            `${TARGETS_JOINED_PLACEHOLDER} is the comma-separated form, for context and commands; bootstrap argv takes ${TARGETS_PLACEHOLDER} as an entry of its own: ${JSON.stringify(entry)}`,
          )
        }
        return [expandHome(expand(entry, 'bootstrap'))]
      }),
  }
}

const resolveWorktreePath = (
  repoConfig: RepoConfig,
  mainRepoRoot: string,
  values: Record<string, string>,
): string => {
  const expanded = expandHome(expandWith(repoConfig.worktree_dir, 'worktree_dir', values, {}))
  // Relative paths resolve against the main checkout, not the caller's cwd:
  // "../foo" must mean the same thing from a skill, a keybinding and a shell.
  return isAbsolute(expanded) ? expanded : resolve(mainRepoRoot, expanded)
}

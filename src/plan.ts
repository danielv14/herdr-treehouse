import { isAbsolute, resolve } from 'node:path'
import { slugFromBranch, ticketFromBranch } from './branch.ts'
import { DEFAULT_BASE, DEFAULT_WORKTREE_DIR, expandHome, type RepoConfig } from './config.ts'

// Everything derived about one worktree, resolved in a single call: callers ask
// once and read fields off the result. Pure: no filesystem, no git, no Herdr.

const PLACEHOLDERS = ['repo', 'branch', 'slug', 'ticket', 'id', 'worktree', 'root', 'base'] as const

const TARGETS_PLACEHOLDER = '{targets...}'

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
  // Expand placeholders in a single string (setup commands, pane commands).
  // `where` only shapes the error message.
  expand: (template: string, where?: string) => string
  // Expand a bootstrap argv: `{targets...}` becomes one entry per target, every
  // other entry gets normal placeholder expansion plus ~ expansion.
  expandArgv: (argv: string[]) => string[]
}

// An unknown placeholder used to pass through unexpanded into shell commands and
// bootstrap argv, so a typo became a literal "{wortkree}" argument that some
// script then mkdir'd. Fail instead, and say which placeholders exist.
//
// Only single-word braces not preceded by `$` are treated as placeholders.
// Config values are shell commands, and braces are ordinary there:
// `docker ps --format '{{.Names}}'`, `kubectl -o jsonpath='{.items[0]}'`,
// `awk '{print $1}'`, `cp ${HOME}/.env .env`. Those never looked like a
// placeholder and must keep passing through untouched.
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
  // Path of a worktree that already exists (Herdr's native flow creates the
  // checkout before the plugin hook runs, so its path is a given, not a
  // worktree_dir question).
  worktree?: string
}

export const buildWorktreePlan = ({
  repoName,
  branch,
  mainRepoRoot,
  repoConfig,
  targets = [],
  worktree,
}: PlanInput): WorktreePlan => {
  const slug = slugFromBranch(branch)
  const ticket = ticketFromBranch(branch)
  const id = ticket || slug
  const base = repoConfig.base ?? DEFAULT_BASE

  const withoutWorktree: Record<string, string> = {
    repo: repoName,
    branch,
    slug,
    ticket,
    id,
    root: mainRepoRoot,
    base,
  }

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

// Sibling by default: `cd ../{repo}-{id}` from the main checkout is the shortest
// path back and forth, worktrees sort next to the repo they belong to, and
// staying outside the checkout keeps them away from watchers, test globs and
// build contexts (which is why Claude Code's own <repo>/.claude/worktrees/
// layout is a poor fit for long-lived tabs).
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

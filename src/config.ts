import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { herdr } from './herdr.ts'

export type PaneConfig = {
  split?: 'down' | 'right'
  ratio?: number
  label?: string
  command?: string
  autostart?: boolean
}

export type RepoConfig = {
  root: string
  worktree_dir?: string
  base?: string
  bootstrap?: string[]
  // Simple shell commands run inside a FRESHLY CREATED worktree (skipped when
  // the worktree already existed), e.g. ["corepack enable", "npm ci"].
  // The middle ground between no bootstrap and a full bootstrap script.
  setup?: string[]
  // Extra panes in the worktree tab. Each entry splits the PREVIOUS pane
  // (the first splits the main/agent pane), so a 1|1 layout with the right
  // column halved is: [{split: "right"}, {split: "down"}].
  panes?: PaneConfig[]
  // Command that starts the coding agent in the main pane. Overrides
  // [defaults].agent; `treehouse up --agent` overrides both.
  agent?: string
}

// Settings that apply to every repo, each overridable per repo. A table rather
// than bare top-level keys on purpose: TOML bare keys attach to whatever table
// precedes them, so an `agent = "..."` line appended below a [repos.X] block
// would silently become that repo's setting instead of the global one.
export type DefaultsConfig = {
  agent?: string
}

export type TreehouseConfig = {
  defaults: DefaultsConfig
  repos: Record<string, RepoConfig>
}

export type TemplateContext = {
  repo: string
  branch: string
  slug: string
  ticket: string
  id: string
  worktree: string
  root: string
  base: string
  targets: string[]
}

export const expandHome = (path: string) =>
  path.startsWith('~') ? join(homedir(), path.slice(1)) : path

export const configDir = (): string => {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR
  const reported = herdr(['plugin', 'config-dir', 'treehouse'])
  if (typeof reported === 'string' && reported !== '') return expandHome(reported)
  throw new Error('could not resolve config dir (HERDR_PLUGIN_CONFIG_DIR unset and `herdr plugin config-dir treehouse` gave nothing)')
}

export const configPath = () => join(configDir(), 'config.toml')

export const loadConfig = async (): Promise<TreehouseConfig> => {
  const path = configPath()
  if (!existsSync(path)) return { defaults: {}, repos: {} }
  const parsed = Bun.TOML.parse(await Bun.file(path).text()) as Partial<TreehouseConfig>
  warnUnknownTopLevelKeys(parsed)
  return { defaults: knownDefaults(parsed.defaults ?? {}), repos: parsed.repos ?? {} }
}

// The TOML is cast straight to the types, so typos (dev_command, autostart at
// repo level, ...) would otherwise be ignored silently and features just not
// happen. Warn loudly instead of failing: an unknown key is never fatal.
const KNOWN_TOP_LEVEL_KEYS = new Set(['defaults', 'repos'])
const KNOWN_DEFAULTS_KEYS = new Set(['agent'])
const KNOWN_REPO_KEYS = new Set(['root', 'worktree_dir', 'base', 'bootstrap', 'setup', 'panes', 'agent'])
const KNOWN_PANE_KEYS = new Set(['split', 'ratio', 'label', 'command', 'autostart'])

// Catches an `agent = "..."` line placed at the top of the file instead of
// inside [defaults], which would otherwise be parsed and dropped in silence.
const warnUnknownTopLevelKeys = (parsed: Partial<TreehouseConfig>) => {
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      console.error(`warning: unknown top-level key "${key}" in config.toml (ignored). Known keys: ${[...KNOWN_TOP_LEVEL_KEYS].join(', ')}`)
    }
  }
}

// Unknown keys are dropped instead of merged into every repo, so a typo in
// [defaults] is reported once against [defaults] rather than once per repo.
const knownDefaults = (defaults: Record<string, unknown>): DefaultsConfig => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaults)) {
    if (KNOWN_DEFAULTS_KEYS.has(key)) result[key] = value
    else console.error(`warning: unknown key "${key}" in [defaults] (ignored). Known keys: ${[...KNOWN_DEFAULTS_KEYS].join(', ')}`)
  }
  return result as DefaultsConfig
}

const warnUnknownKeys = (repoName: string, config: RepoConfig) => {
  for (const key of Object.keys(config)) {
    if (!KNOWN_REPO_KEYS.has(key)) {
      console.error(`warning: unknown config key "${key}" for repo ${repoName} (ignored). Known keys: ${[...KNOWN_REPO_KEYS].join(', ')}`)
    }
  }
  for (const pane of config.panes ?? []) {
    for (const key of Object.keys(pane)) {
      if (!KNOWN_PANE_KEYS.has(key)) {
        console.error(`warning: unknown pane key "${key}" for repo ${repoName} (ignored). Known keys: ${[...KNOWN_PANE_KEYS].join(', ')}`)
      }
    }
  }
}

const sameDir = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// Config for a repo, layered lowest to highest: [defaults] from the central
// config.toml, then its [repos.X] entry, then a repo-local .treehouse.toml at
// the main checkout root.
export const resolveRepoConfig = async (mainRepoRoot: string): Promise<{ name: string; config: RepoConfig }> => {
  const { defaults, repos } = await loadConfig()
  const entry = Object.entries(repos).find(([, repo]) => sameDir(expandHome(repo.root), mainRepoRoot))
  let name = entry?.[0] ?? basename(mainRepoRoot)
  let config: RepoConfig = { ...defaults, ...(entry?.[1] ?? { root: mainRepoRoot }) }

  const localPath = join(mainRepoRoot, '.treehouse.toml')
  if (existsSync(localPath)) {
    const local = Bun.TOML.parse(await Bun.file(localPath).text()) as Partial<RepoConfig>
    config = { ...config, ...local, root: mainRepoRoot }
  }
  warnUnknownKeys(name, config)
  return { name, config }
}

export const slugFromBranch = (branch: string) =>
  branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

export const ticketFromBranch = (branch: string) => {
  const match = branch.match(/^([a-zA-Z]+-\d+)/)
  return match ? match[1].toLowerCase() : ''
}

export const buildTemplateContext = (
  repoName: string,
  branch: string,
  base: string,
  targets: string[],
  mainRepoRoot: string,
): Omit<TemplateContext, 'worktree'> => {
  const slug = slugFromBranch(branch)
  const ticket = ticketFromBranch(branch)
  return { repo: repoName, branch, slug, ticket, id: ticket || slug, root: mainRepoRoot, base, targets }
}

export const expandTemplate = (template: string, context: Record<string, unknown>) =>
  template.replace(/\{(\w+)\}/g, (whole, key) => {
    const value = context[key]
    return typeof value === 'string' ? value : whole
  })

// `{targets...}` expands to one argv entry per target; other entries get
// normal placeholder expansion.
export const expandArgv = (argv: string[], context: TemplateContext): string[] =>
  argv.flatMap((entry) =>
    entry === '{targets...}' ? context.targets : [expandHome(expandTemplate(entry, context))],
  )

export const resolveWorktreePath = (
  repoConfig: RepoConfig,
  mainRepoRoot: string,
  context: Omit<TemplateContext, 'worktree'>,
): string => {
  const template = repoConfig.worktree_dir ?? '~/.herdr/worktrees/{repo}/{id}'
  const expanded = expandHome(expandTemplate(template, context))
  return isAbsolute(expanded) ? expanded : resolve(mainRepoRoot, expanded)
}

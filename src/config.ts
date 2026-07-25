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
  agent?: string
}

export type TreehouseConfig = {
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
  if (!existsSync(path)) return { repos: {} }
  const parsed = Bun.TOML.parse(await Bun.file(path).text()) as Partial<TreehouseConfig>
  return { repos: parsed.repos ?? {} }
}

const sameDir = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// Repo config from the central config.toml, overridden by a repo-local
// .treehouse.toml at the main checkout root when present.
export const resolveRepoConfig = async (mainRepoRoot: string): Promise<{ name: string; config: RepoConfig }> => {
  const { repos } = await loadConfig()
  const entry = Object.entries(repos).find(([, repo]) => sameDir(expandHome(repo.root), mainRepoRoot))
  let name = entry?.[0] ?? basename(mainRepoRoot)
  let config: RepoConfig = entry?.[1] ?? { root: mainRepoRoot }

  const localPath = join(mainRepoRoot, '.treehouse.toml')
  if (existsSync(localPath)) {
    const local = Bun.TOML.parse(await Bun.file(localPath).text()) as Partial<RepoConfig>
    config = { ...config, ...local, root: mainRepoRoot }
  }
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

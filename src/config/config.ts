import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { reportDiagnostics, type Diagnostic } from './diagnostics.ts'
import {
  describe,
  isTable,
  validateTable,
  type Declared,
  type Shape,
  type StringCheck,
  type WithDefaulted,
} from './shape.ts'

type PaneConfig = WithDefaulted<Declared<typeof PANE_SHAPE>, 'split' | 'ratio' | 'autostart'>

export type RepoConfig = WithDefaulted<
  Omit<Declared<typeof REPO_SHAPE>, 'panes'>,
  'root' | 'base' | 'worktree_dir'
> & { panes: PaneConfig[] }

// One config level's own view of the same keys: nothing promised, since a level
// says only what it changes. `root` is optional here too - a repo-local file has
// none, and a [repos.X] block gets it required at validation.
type DeclaredRepo = Declared<typeof REPO_SHAPE>

type DefaultsConfig = Declared<typeof DEFAULTS_SHAPE>

type TreehouseConfig = {
  defaults: DefaultsConfig
  repos: Record<string, DeclaredRepo>
}

export const expandHome = (path: string) =>
  path.startsWith('~') ? join(homedir(), path.slice(1)) : path

export const configPath = (configDir: string) => join(configDir, 'config.toml')

const DEFAULT_BASE = 'origin/master'

const DEFAULT_WORKTREE_DIR = '../{repo}-{id}'

const PANE_DEFAULTS = { split: 'down', ratio: 0.5, autostart: false } as const

export const LOCAL_CONFIG_FILE = '.treehouse.toml'

// `as const satisfies Shape` on each declaration keeps the literal types
// (Declared<> needs them to narrow `values` and find each `shape`) while still
// checking the declaration against Shape.
const PANE_SHAPE = {
  split: { kind: 'string', values: ['down', 'right'] },
  ratio: { kind: 'number' },
  label: { kind: 'string' },
  command: { kind: 'string' },
  autostart: { kind: 'boolean' },
} as const satisfies Shape

const ABSOLUTE_ROOT: StringCheck = {
  expected: 'an absolute path',
  // ~ is expanded first, or root = "~/dev/foo" would fail wrongly. An empty or
  // relative root resolves against the caller's cwd (the plugin dir when a hook
  // runs) and would claim whichever repo the caller happens to stand in.
  ok: (value) => isAbsolute(expandHome(value)),
}

const REPO_SHAPE = {
  root: { kind: 'string', check: ABSOLUTE_ROOT },
  worktree_dir: { kind: 'string' },
  base: { kind: 'string' },
  bootstrap: { kind: 'string-list' },
  setup: { kind: 'string-list' },
  panes: { kind: 'table-list', shape: PANE_SHAPE },
  agent: { kind: 'string' },
  context: { kind: 'string' },
  model_arg: { kind: 'string' },
} as const satisfies Shape

// A table rather than bare top-level keys on purpose: TOML bare keys attach to
// whatever table precedes them, so an `agent = "..."` line appended below a
// [repos.X] block would silently become that repo's setting.
const DEFAULTS_SHAPE = {
  agent: { kind: 'string' },
  context: { kind: 'string' },
  model_arg: { kind: 'string' },
} as const satisfies Shape

const TOP_LEVEL_SHAPE = {
  defaults: { kind: 'table', shape: DEFAULTS_SHAPE },
  repos: { kind: 'table-map', shape: REPO_SHAPE, required: ['root'] },
} as const satisfies Shape

// Destructuring rather than Object.fromEntries so the entry types survive and
// Declared<typeof LOCAL_SHAPE> stays precise.
const { root: _centralOnly, ...LOCAL_SHAPE } = REPO_SHAPE

type RepoProposal = {
  name: string
  root: string
  installCommand?: string
  devCommand?: string
}

// TOML bare keys are letters, digits, dashes and underscores; anything else
// needs quoting. JSON string escapes are a subset of TOML basic string escapes,
// so JSON.stringify renders a valid TOML string either way.
const BARE_KEY = /^[A-Za-z0-9_-]+$/

// Rendered next to the shape it must satisfy; config.test.ts round-trips the
// output through the validators, commented examples included. Scalars stay
// above the pane table or TOML reads them as pane keys.
export const renderProposedBlock = (proposal: RepoProposal, home: 'central' | 'local'): string => {
  const tomlKey = BARE_KEY.test(proposal.name) ? proposal.name : JSON.stringify(proposal.name)
  const head =
    home === 'local'
      ? [
          `# treehouse config for ${proposal.name}. Same fields as a [repos.X] block in the`,
          '# central plugin config, minus the wrapper and `root`. Keep scalar keys above',
          '# [[panes]] or TOML reads them as pane keys.',
        ]
      : [`[repos.${tomlKey}]`, `root = ${JSON.stringify(proposal.root)}`]
  return [
    ...head,
    `# worktree_dir = "${DEFAULT_WORKTREE_DIR.replace('{repo}', proposal.name)}"  # this is the default; set it only for a different layout`,
    `# base = "${DEFAULT_BASE}"`,
    home === 'local'
      ? `# bootstrap = ["{root}/scripts/worktree-up.sh", "--dir", "{worktree}", "{branch}", "{targets...}"]`
      : `# bootstrap = ["{config_dir}/bootstraps/${proposal.name}.sh", "--dir", "{worktree}", "{branch}", "{targets...}"]`,
    proposal.installCommand
      ? `setup = [${JSON.stringify(proposal.installCommand)}]`
      : `# setup = ["npm ci"]  # commands run in a freshly created worktree`,
    '',
    home === 'local' ? '[[panes]]' : `[[repos.${tomlKey}.panes]]`,
    `split = "${PANE_DEFAULTS.split}"`,
    'label = "dev"',
    proposal.devCommand ? `command = ${JSON.stringify(proposal.devCommand)}` : '# command = "npm run dev"',
    `autostart = ${PANE_DEFAULTS.autostart}`,
  ].join('\n')
}

const validateConfigFile = (
  raw: unknown,
  file: string,
): { config: TreehouseConfig; diagnostics: Diagnostic[] } => {
  const diagnostics: Diagnostic[] = []
  if (!isTable(raw)) {
    return {
      config: { defaults: {}, repos: {} },
      diagnostics: [{ severity: 'error', message: `${file}: expected a table at the top level, found ${describe(raw)}` }],
    }
  }
  const validated = validateTable(raw, TOP_LEVEL_SHAPE, { file, prefix: '' }, diagnostics)
  return {
    config: {
      defaults: validated.defaults ?? {},
      repos: validated.repos ?? {},
    },
    diagnostics,
  }
}

const validateLocalConfigFile = (
  raw: unknown,
  file: string,
): { config: DeclaredRepo; diagnostics: Diagnostic[] } => {
  const diagnostics: Diagnostic[] = []
  if (!isTable(raw)) {
    return {
      config: {},
      diagnostics: [{ severity: 'error', message: `${file}: expected a table at the top level, found ${describe(raw)}` }],
    }
  }
  if (raw.root !== undefined) {
    diagnostics.push({
      severity: 'warning',
      message: `"root" in ${file} is ignored (the repo root is where the file lives)`,
    })
  }
  const { root: _ignored, ...rest } = raw
  const validated = validateTable(rest, LOCAL_SHAPE, { file, prefix: '' }, diagnostics)
  return { config: validated, diagnostics }
}

const parseToml = async (path: string): Promise<unknown> => {
  try {
    return Bun.TOML.parse(await Bun.file(path).text())
  } catch (error) {
    throw new Error(`could not parse ${path}: ${error instanceof Error ? error.message : error}`)
  }
}

const loadConfig = async (
  configDir: string,
): Promise<{ config: TreehouseConfig; diagnostics: Diagnostic[] }> => {
  const path = configPath(configDir)
  if (!existsSync(path)) return { config: { defaults: {}, repos: {} }, diagnostics: [] }
  return validateConfigFile(await parseToml(path), path)
}

const sameDir = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// Matched by path, not by name: the config key is a label, `root` is the
// identity. Shared with onboard so both answer "already configured" the same way.
const findRepoEntry = (
  repos: Record<string, DeclaredRepo>,
  mainRepoRoot: string,
): [string, DeclaredRepo] | undefined =>
  Object.entries(repos).find(
    ([, repo]) =>
      // ABSOLUTE_ROOT drops a root it rejects, so a block can arrive here
      // without one at all: the single-repo path matches before it reports
      // diagnostics. Nothing to compare, hence no match (realpathSync('')
      // would be the cwd).
      repo.root !== undefined && sameDir(expandHome(repo.root), mainRepoRoot),
  )

const isRepoScoped = (diagnostic: Diagnostic) => diagnostic.key?.startsWith('repos.') ?? false

// The trailing dot matters: repos.foobar must not read as scoped to repos.foo.
const isScopedToRepo = (diagnostic: Diagnostic, name: string) =>
  diagnostic.key === `repos.${name}` || (diagnostic.key?.startsWith(`repos.${name}.`) ?? false)

// Demotes other repos' errors to warnings: a typo in [repos.b] must not break
// every command for repo a. Pass the matched entry's key (falling back to the
// checkout's directory name) so a block that broke its own `root` cannot demote
// itself to "another repo's block" and slip through.
const diagnosticsForRepo = (diagnostics: Diagnostic[], repoName: string): Diagnostic[] =>
  diagnostics.map((diagnostic) => {
    if (diagnostic.severity !== 'error' || !isRepoScoped(diagnostic)) return diagnostic
    if (isScopedToRepo(diagnostic, repoName)) return diagnostic
    return {
      ...diagnostic,
      severity: 'warning',
      message: `${diagnostic.message} (another repo's block, ignored here)`,
    }
  })

const loadLocalConfig = async (
  mainRepoRoot: string,
): Promise<{ config: DeclaredRepo; diagnostics: Diagnostic[] }> => {
  const localPath = join(mainRepoRoot, LOCAL_CONFIG_FILE)
  if (!existsSync(localPath)) return { config: {}, diagnostics: [] }
  return validateLocalConfigFile(await parseToml(localPath), localPath)
}

const withDefaults = (declared: DeclaredRepo, root: string): RepoConfig => ({
  ...declared,
  root,
  base: declared.base ?? DEFAULT_BASE,
  worktree_dir: declared.worktree_dir ?? DEFAULT_WORKTREE_DIR,
  panes: (declared.panes ?? []).map((pane) => ({
    ...pane,
    split: pane.split ?? PANE_DEFAULTS.split,
    ratio: pane.ratio ?? PANE_DEFAULTS.ratio,
    autostart: pane.autostart ?? PANE_DEFAULTS.autostart,
  })),
})

export const resolveRepoConfig = async (
  mainRepoRoot: string,
  configDir: string,
  warn: (message: string) => void,
): Promise<{ name: string; config: RepoConfig }> => {
  const { config: loaded, diagnostics } = await loadConfig(configDir)
  const entry = findRepoEntry(loaded.repos, mainRepoRoot)
  const name = entry?.[0] ?? basename(mainRepoRoot)
  const local = await loadLocalConfig(mainRepoRoot)
  diagnostics.push(...local.diagnostics)
  const config = withDefaults({ ...loaded.defaults, ...(entry?.[1] ?? {}), ...local.config }, mainRepoRoot)
  reportDiagnostics(diagnosticsForRepo(diagnostics, name), warn)
  return { name, config }
}

// Repos known only by a repo-local .treehouse.toml are invisible here by
// design: there is deliberately no registry of them.
export const resolveAllRepoConfigs = async (
  configDir: string,
  warn: (message: string) => void,
): Promise<Array<{ name: string; config: RepoConfig }>> => {
  const { config: loaded, diagnostics } = await loadConfig(configDir)
  // Repo-scoped errors demote to warnings (the repo is skipped below, not the
  // run); errors outside any repo block break every entry equally and still stop.
  reportDiagnostics(
    diagnostics.map((diagnostic) =>
      diagnostic.severity === 'error' && isRepoScoped(diagnostic)
        ? { ...diagnostic, severity: 'warning' as const, message: `${diagnostic.message} (repo skipped here)` }
        : diagnostic,
    ),
    warn,
  )

  const brokenRepo = (name: string) =>
    diagnostics.some(
      (diagnostic) => diagnostic.severity === 'error' && isScopedToRepo(diagnostic, name),
    )

  const resolved: Array<{ name: string; config: RepoConfig }> = []
  for (const [name, entry] of Object.entries(loaded.repos)) {
    if (brokenRepo(name)) continue
    // Present and absolute by then (a rejected or missing root is an error under
    // repos.<name>.root, which brokenRepo skipped above); the guard is what
    // proves that to the type checker.
    if (entry.root === undefined) continue
    const root = expandHome(entry.root)
    const local = await loadLocalConfig(root)
    if (local.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      warn(`warning: skipping ${name}: its ${LOCAL_CONFIG_FILE} has errors (see treehouse up in that repo for details)`)
      continue
    }
    for (const diagnostic of local.diagnostics) warn(`warning: ${diagnostic.message}`)
    resolved.push({ name, config: withDefaults({ ...loaded.defaults, ...entry, ...local.config }, root) })
  }
  return resolved
}

export const configuredRepoName = async (
  mainRepoRoot: string,
  configDir: string,
  warn: (message: string) => void,
): Promise<string | undefined> => {
  const { config, diagnostics } = await loadConfig(configDir)
  const entry = findRepoEntry(config.repos, mainRepoRoot)
  reportDiagnostics(diagnosticsForRepo(diagnostics, entry?.[0] ?? basename(mainRepoRoot)), warn)
  return entry?.[0]
}
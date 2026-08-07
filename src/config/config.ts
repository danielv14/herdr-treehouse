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

// The treehouse config: its shape, defaults and resolution policy. The generic
// declare-and-validate engine lives in shape.ts; policy and rationale in
// docs/config.md; field semantics in config.example.toml.

// The types a consumer reads are derived from the shape declarations below via
// Declared<>, the way parsing and help both derive from cli.ts's declarations:
// a key added to a shape is a key the types know, with no second list to keep
// in step. Declared<> is everything-optional (a level says only what it
// changes); WithDefaulted names the keys the resolvers promise to fill in.

// A pane as the resolvers hand it over: the keys that have a default are always
// there. `label` and `command` have none (a pane can be a bare shell).
type PaneConfig = WithDefaulted<Declared<typeof PANE_SHAPE>, 'split' | 'ratio' | 'autostart'>

// What the resolvers return: layered, with the defaults applied. A key with a
// default is a fact here, so no consumer decides one for itself; a key without
// one stays optional, so absence keeps meaning "not configured".
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

// Resolving WHERE the config dir is takes asking Herdr (pluginConfigDir in
// tabs.ts); everything here takes the resolved dir.
export const configPath = (configDir: string) => join(configDir, 'config.toml')

// Defaults applied when config leaves a field out. Applied by the resolvers
// below, the one place that sees every level; renderProposedBlock advertises
// them, and config.test.ts pins that its commented lines resolve to the same
// values, so onboard cannot drift from what the engine does.
const DEFAULT_BASE = 'origin/master'

const DEFAULT_WORKTREE_DIR = '../{repo}-{id}'

const PANE_DEFAULTS = { split: 'down', ratio: 0.5, autostart: false } as const

export const LOCAL_CONFIG_FILE = '.treehouse.toml'

// ---------------------------------------------------------------------------
// Shape declaration
// ---------------------------------------------------------------------------

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
  // Standing agent instructions, delivered through the agent command's
  // {context_file}. Layered like every other key: replaces, never appends.
  context: { kind: 'string' },
  // How this repo's agent spells a model, e.g. '--model {model}'. The engine
  // holds no opinion about the flag; it only fills the {model_arg} slot the
  // agent command declares, with what --model was given.
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
  // `root` is required: it is what matches a block to a checkout.
  repos: { kind: 'table-map', shape: REPO_SHAPE, required: ['root'] },
} as const satisfies Shape

// A repo-local .treehouse.toml holds the same fields without the [repos.X]
// wrapper, and without `root`: the file's own location is the repo root.
// Destructuring rather than Object.fromEntries so the entry types survive and
// Declared<typeof LOCAL_SHAPE> stays precise.
const { root: _centralOnly, ...LOCAL_SHAPE } = REPO_SHAPE

// ---------------------------------------------------------------------------
// Rendering a proposed block (the write side of the shape)
// ---------------------------------------------------------------------------

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
    // argv[0] needs a path that does not depend on cwd, so each home is shown
    // the anchor it has: the config dir centrally, the repo itself locally.
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Both validator entry points are private: their behaviour is reached through
// the resolvers below, which is where a call site meets it too.
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

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

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

// The `repos.<name>[.<field>]` key convention, read in one place. Three call
// sites ask these two questions and want different answers from them.
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

// The layered levels with the defaults filled in, so what a consumer reads is
// what the engine does. Each pane gets its own: a pane declares only the keys it
// changes, and the layering replaces the list wholesale.
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

// Layered lowest to highest: [defaults], the repo's [repos.X] entry, then a
// repo-local .treehouse.toml. Reports its own diagnostics before returning, so
// a call site cannot obtain a usable config while an unreported error sits in
// the data.
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

// The multi-repo view (ls, report): same layering per repo, but a repo whose
// own block or local file is broken is skipped with a warning instead of
// stopping the listing. Repos known only by a repo-local .treehouse.toml are
// invisible here by design: there is deliberately no registry of them.
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

// Onboard's view of the central config: the config key (if any) whose `root`
// already claims the checkout, with the same demote-and-report policy as
// resolveRepoConfig.
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
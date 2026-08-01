import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { reportDiagnostics } from './diagnostics.ts'

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

export const expandHome = (path: string) =>
  path.startsWith('~') ? join(homedir(), path.slice(1)) : path

// Resolving WHERE the config dir is takes asking Herdr, which is the Herdr
// module's job (pluginConfigDir in tabs.ts). Everything here takes the resolved
// dir: TOML in, typed config plus diagnostics out.
export const configPath = (configDir: string) => join(configDir, 'config.toml')

// The defaults applied when config leaves a field out, declared next to the
// shape they belong to. plan.ts applies the first two, up.ts the pane ones, and
// renderProposedBlock below advertises them, so onboard cannot drift from what
// the engine actually does.
export const DEFAULT_BASE = 'origin/master'

export const DEFAULT_WORKTREE_DIR = '../{repo}-{id}'

export const PANE_DEFAULTS = { split: 'down', ratio: 0.5, autostart: false } as const

// Per-repo config checked into (or gitignored inside) the repo itself, for
// repos whose config has no reason to live in the user's plugin config dir.
export const LOCAL_CONFIG_FILE = '.treehouse.toml'

// ---------------------------------------------------------------------------
// Shape declaration
// ---------------------------------------------------------------------------

// The TOML arrives as untyped data, so keys AND value shapes are declared once
// here and checked in a single pass. Both halves matter: a typo'd key means a
// feature silently never happens, and a wrong value shape used to reach the
// engine as-is (a string `setup` ran one command per character, a quoted
// `autostart = "false"` was truthy and started dev servers that must not race).
type FieldSpec =
  | { kind: 'string'; values?: readonly string[] }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'string-list' }
  | { kind: 'table'; shape: Shape; required?: readonly string[] }
  | { kind: 'table-list'; shape: Shape; required?: readonly string[] }
  // `required` applies to each entry of the map, not to the map itself.
  | { kind: 'table-map'; shape: Shape; required?: readonly string[] }

type Shape = Record<string, FieldSpec>

const PANE_SHAPE: Shape = {
  split: { kind: 'string', values: ['down', 'right'] },
  ratio: { kind: 'number' },
  label: { kind: 'string' },
  command: { kind: 'string' },
  autostart: { kind: 'boolean' },
}

const REPO_SHAPE: Shape = {
  root: { kind: 'string' },
  worktree_dir: { kind: 'string' },
  base: { kind: 'string' },
  bootstrap: { kind: 'string-list' },
  setup: { kind: 'string-list' },
  panes: { kind: 'table-list', shape: PANE_SHAPE },
  agent: { kind: 'string' },
}

const DEFAULTS_SHAPE: Shape = {
  agent: { kind: 'string' },
}

const TOP_LEVEL_SHAPE: Shape = {
  defaults: { kind: 'table', shape: DEFAULTS_SHAPE },
  // `root` is what matches a [repos.X] block to a checkout. Without it the block
  // can only be dead weight, and an empty root resolves to the caller's cwd, so
  // the block would silently claim whichever repo you ran from.
  repos: { kind: 'table-map', shape: REPO_SHAPE, required: ['root'] },
}

// A repo-local .treehouse.toml holds the same fields without the [repos.X]
// wrapper, and without `root`: the file's own location is the repo root.
const LOCAL_SHAPE: Shape = Object.fromEntries(
  Object.entries(REPO_SHAPE).filter(([key]) => key !== 'root'),
)

// ---------------------------------------------------------------------------
// Rendering a proposed block (the write side of the shape)
// ---------------------------------------------------------------------------

// What onboard learned about a repo; everything else the block shows comes from
// the defaults above.
export type RepoProposal = {
  name: string
  root: string
  installCommand?: string
  devCommand?: string
}

// The block onboard proposes, rendered next to the shape it must satisfy so the
// key names and the advertised defaults cannot drift from what validation
// accepts (config.test.ts round-trips it through the validators, commented
// examples included). Two homes of the same fields: the central config
// namespaces them under [repos.X] and needs `root` to find the repo; a
// repo-local .treehouse.toml is already at its repo, so it drops both. Scalars
// stay above the pane table: TOML would otherwise read them as pane keys.
// TOML bare keys are letters, digits, dashes and underscores; anything else
// (dots, spaces) needs quoting. JSON string escapes are a subset of TOML basic
// string escapes, so JSON.stringify renders a valid TOML string either way.
const BARE_KEY = /^[A-Za-z0-9_-]+$/

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
    `# bootstrap = ["path/to/bootstrap.sh", "--dir", "{worktree}", "{branch}", "{targets...}"]`,
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

// The validators return diagnostics as data so tests can assert on them; what a
// diagnostic means for a run is diagnostics.ts's decision, applied inside the
// resolvers below so no caller can obtain a usable config while an unreported
// error sits in the data. Unknown keys are warnings - never fatal, the config
// still works. A wrong value shape is an error: guessing what was meant is how
// "false" started dev servers.
export type Diagnostic = {
  severity: 'warning' | 'error'
  message: string
  // TOML path the diagnostic belongs to, e.g. "repos.npm-packages.setup". Lets a
  // caller tell "my repo's block is broken" from "some other repo's block is".
  key?: string
}

type Scope = {
  file: string
  // TOML path of the enclosing table, e.g. "repos.npm-packages". Empty at the
  // top level of a file.
  prefix: string
}

const child = (scope: Scope, key: string): Scope => ({
  file: scope.file,
  prefix: scope.prefix === '' ? key : `${scope.prefix}.${key}`,
})

const tableLabel = (scope: Scope) =>
  scope.prefix === '' ? `the top level of ${scope.file}` : `[${scope.prefix}] in ${scope.file}`

const keyPath = (scope: Scope, key: string) =>
  scope.prefix === '' ? key : `${scope.prefix}.${key}`

const keyLabel = (scope: Scope, key: string) => `${keyPath(scope, key)} in ${scope.file}`

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const describe = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  switch (typeof value) {
    case 'string':
      return `a string (${JSON.stringify(value)})`
    case 'number':
      return `a number (${value})`
    case 'boolean':
      return `a boolean (${value})`
    case 'object':
      return 'a table'
    default:
      return typeof value
  }
}

const expected = (spec: FieldSpec): string => {
  switch (spec.kind) {
    case 'string':
      return spec.values ? `one of ${spec.values.map((v) => JSON.stringify(v)).join(', ')}` : 'a string'
    case 'number':
      return 'a number'
    case 'boolean':
      return 'a boolean (unquoted true or false)'
    case 'string-list':
      return 'a list of strings'
    case 'table':
      return 'a table'
    case 'table-list':
      return 'a list of tables'
    case 'table-map':
      return 'a table of tables'
  }
}

const validateField = (
  spec: FieldSpec,
  raw: unknown,
  scope: Scope,
  key: string,
  diagnostics: Diagnostic[],
): unknown => {
  const reject = (found = describe(raw)) => {
    diagnostics.push({
      severity: 'error',
      key: keyPath(scope, key),
      message: `${keyLabel(scope, key)}: expected ${expected(spec)}, found ${found}`,
    })
    return undefined
  }

  switch (spec.kind) {
    case 'string':
      if (typeof raw !== 'string') return reject()
      if (spec.values && !spec.values.includes(raw)) return reject(JSON.stringify(raw))
      return raw
    case 'number':
      return typeof raw === 'number' ? raw : reject()
    case 'boolean':
      return typeof raw === 'boolean' ? raw : reject()
    case 'string-list': {
      if (!Array.isArray(raw)) return reject()
      const wrong = raw.findIndex((entry) => typeof entry !== 'string')
      if (wrong !== -1) return reject(`a list with ${describe(raw[wrong])} at index ${wrong}`)
      return raw
    }
    case 'table':
      if (!isTable(raw)) return reject()
      return validateTable(raw, spec.shape, child(scope, key), diagnostics, spec.required)
    case 'table-list': {
      if (isTable(raw)) {
        // The single-vs-double bracket mistake: [repos.X.panes] parses as one
        // table, [[repos.X.panes]] as a list of them. Worth its own message,
        // because the generic "expected a list" says nothing about the fix.
        const path = keyPath(scope, key)
        diagnostics.push({
          severity: 'error',
          key: path,
          message: `${keyLabel(scope, key)}: expected ${expected(spec)}, found a single table. Write [[${path}]] (double brackets) so each ${key.replace(/s$/, '')} is its own entry, not [${path}].`,
        })
        return undefined
      }
      if (!Array.isArray(raw)) return reject()
      const entries = raw.map((entry, index) => {
        if (!isTable(entry)) {
          diagnostics.push({
            severity: 'error',
            key: `${keyPath(scope, key)}[${index}]`,
            message: `${keyLabel(scope, key)}[${index}]: expected a table, found ${describe(entry)}`,
          })
          return undefined
        }
        return validateTable(entry, spec.shape, child(scope, `${key}[${index}]`), diagnostics, spec.required)
      })
      return entries.filter((entry) => entry !== undefined)
    }
    case 'table-map': {
      if (!isTable(raw)) return reject()
      const result: Record<string, unknown> = {}
      for (const [name, entry] of Object.entries(raw)) {
        if (!isTable(entry)) {
          diagnostics.push({
            severity: 'error',
            key: keyPath(child(scope, key), name),
            message: `${keyLabel(child(scope, key), name)}: expected a table, found ${describe(entry)}`,
          })
          continue
        }
        result[name] = validateTable(
          entry,
          spec.shape,
          child(child(scope, key), name),
          diagnostics,
          spec.required,
        )
      }
      return result
    }
  }
}

// Returns only known keys with valid values, so everything downstream can trust
// the declared types without re-checking.
const validateTable = (
  raw: Record<string, unknown>,
  shape: Shape,
  scope: Scope,
  diagnostics: Diagnostic[],
  required: readonly string[] = [],
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const spec = shape[key]
    if (!spec) {
      diagnostics.push({
        severity: 'warning',
        key: keyPath(scope, key),
        message: `unknown key "${key}" in ${tableLabel(scope)} (ignored). Known keys: ${Object.keys(shape).join(', ')}`,
      })
      continue
    }
    const validated = validateField(spec, value, scope, key, diagnostics)
    if (validated !== undefined) result[key] = validated
  }
  for (const key of required) {
    if (result[key] === undefined) {
      diagnostics.push({
        severity: 'error',
        key: keyPath(scope, key),
        message: `${tableLabel(scope)}: missing required key "${key}"`,
      })
    }
  }
  return result
}

export const validateConfigFile = (
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
      defaults: (validated.defaults ?? {}) as DefaultsConfig,
      repos: (validated.repos ?? {}) as Record<string, RepoConfig>,
    },
    diagnostics,
  }
}

export const validateLocalConfigFile = (
  raw: unknown,
  file: string,
): { config: Partial<RepoConfig>; diagnostics: Diagnostic[] } => {
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
  return { config: validated as Partial<RepoConfig>, diagnostics }
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

export const loadConfig = async (
  configDir: string,
): Promise<{ config: TreehouseConfig; diagnostics: Diagnostic[] }> => {
  const path = configPath(configDir)
  if (!existsSync(path)) return { config: { defaults: {}, repos: {} }, diagnostics: [] }
  return validateConfigFile(await parseToml(path), path)
}

const sameDir = (a: string, b: string) => {
  // realpathSync('') resolves to the process cwd, so an empty root would match
  // whichever repo the caller happens to stand in. A block without a usable root
  // matches nothing (validation reports it separately).
  if (a === '' || b === '') return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// Which [repos.X] block belongs to a checkout, by path rather than by name: the
// config key is a label, `root` is the identity. Shared with onboard so both
// answer "is this repo already configured" the same way.
export const findRepoEntry = (
  repos: Record<string, RepoConfig>,
  mainRepoRoot: string,
): [string, RepoConfig] | undefined =>
  Object.entries(repos).find(([, repo]) => sameDir(expandHome(repo.root ?? ''), mainRepoRoot))

// A broken block in some other repo's config must not stop work in this one: a
// typo in [repos.b] would otherwise break every command for repo a, including
// the worktree.created hook. Pass the resolved repo name: the matched entry's
// key, falling back to the checkout's directory name, so a block that would
// configure this repo but broke its own `root` (the match key) cannot demote
// itself to "another repo's block" and slip through. Undefined means no single
// repo is in scope.
export const diagnosticsForRepo = (
  diagnostics: Diagnostic[],
  repoName: string | undefined,
): Diagnostic[] =>
  diagnostics.map((diagnostic) => {
    if (diagnostic.severity !== 'error' || !diagnostic.key?.startsWith('repos.')) return diagnostic
    const mine =
      repoName !== undefined &&
      (diagnostic.key === `repos.${repoName}` || diagnostic.key.startsWith(`repos.${repoName}.`))
    if (mine) return diagnostic
    return {
      ...diagnostic,
      severity: 'warning',
      message: `${diagnostic.message} (another repo's block, ignored here)`,
    }
  })

// Config for a repo, layered lowest to highest: [defaults] from the central
// config.toml, then its [repos.X] entry, then a repo-local .treehouse.toml at
// the main checkout root. Reports its own diagnostics: the returned config is
// either usable or the run has already stopped, so "diagnostics existed but
// nobody looked" is not expressible at a call site.
const loadLocalConfig = async (
  mainRepoRoot: string,
): Promise<{ config: Partial<RepoConfig>; diagnostics: Diagnostic[] }> => {
  const localPath = join(mainRepoRoot, LOCAL_CONFIG_FILE)
  if (!existsSync(localPath)) return { config: {}, diagnostics: [] }
  return validateLocalConfigFile(await parseToml(localPath), localPath)
}

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
  const config: RepoConfig = {
    ...loaded.defaults,
    ...(entry?.[1] ?? {}),
    ...local.config,
    root: mainRepoRoot,
  }
  reportDiagnostics(diagnosticsForRepo(diagnostics, name), warn)
  return { name, config }
}

// Every centrally configured repo with the same layering as resolveRepoConfig,
// for commands that span repos (ls, report) rather than act on one. Repos known
// only by a repo-local .treehouse.toml are invisible here by design: there is
// deliberately no registry of them. A repo whose own block or local file is
// broken is skipped with a warning instead of stopping the listing - one bad
// block must not blind the overview to every other repo.
export const resolveAllRepoConfigs = async (
  configDir: string,
  warn: (message: string) => void,
): Promise<Array<{ name: string; config: RepoConfig }>> => {
  const { config: loaded, diagnostics } = await loadConfig(configDir)
  // Errors outside any repo block (a malformed [defaults], an unreadable top
  // level) break every entry equally, so they still stop the run.
  reportDiagnostics(diagnostics.filter((diagnostic) => !diagnostic.key?.startsWith('repos.')), warn)

  const brokenRepo = (name: string) =>
    diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === 'error' &&
        (diagnostic.key === `repos.${name}` || diagnostic.key?.startsWith(`repos.${name}.`)),
    )

  const resolved: Array<{ name: string; config: RepoConfig }> = []
  for (const [name, entry] of Object.entries(loaded.repos)) {
    if (brokenRepo(name)) {
      warn(`warning: skipping ${name}: its config block has errors (see treehouse up in that repo for details)`)
      continue
    }
    const root = expandHome(entry.root)
    const local = await loadLocalConfig(root)
    if (local.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      warn(`warning: skipping ${name}: its ${LOCAL_CONFIG_FILE} has errors (see treehouse up in that repo for details)`)
      continue
    }
    for (const diagnostic of local.diagnostics) warn(`warning: ${diagnostic.message}`)
    resolved.push({ name, config: { ...loaded.defaults, ...entry, ...local.config, root } })
  }
  return resolved
}

// Onboard's view of the central config: which entry (if any) already claims the
// checkout, with the same demote-and-report policy as resolveRepoConfig, so a
// broken block for another repo cannot block onboarding this one.
export const findConfiguredEntry = async (
  mainRepoRoot: string,
  configDir: string,
  warn: (message: string) => void,
): Promise<[string, RepoConfig] | undefined> => {
  const { config, diagnostics } = await loadConfig(configDir)
  const entry = findRepoEntry(config.repos, mainRepoRoot)
  reportDiagnostics(diagnosticsForRepo(diagnostics, entry?.[0] ?? basename(mainRepoRoot)), warn)
  return entry
}

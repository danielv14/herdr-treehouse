import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Environment } from './context.ts'
import type { HerdrInvoker } from './herdr.ts'

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

export const configDir = (invoke: HerdrInvoker, env: Environment): string => {
  if (env.HERDR_PLUGIN_CONFIG_DIR) return env.HERDR_PLUGIN_CONFIG_DIR
  const reported = invoke(['plugin', 'config-dir', 'treehouse'])
  if (typeof reported === 'string' && reported !== '') return expandHome(reported)
  throw new Error('could not resolve config dir (HERDR_PLUGIN_CONFIG_DIR unset and `herdr plugin config-dir treehouse` gave nothing)')
}

export const configPath = (invoke: HerdrInvoker, env: Environment) =>
  join(configDir(invoke, env), 'config.toml')

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
// Validation
// ---------------------------------------------------------------------------

// Diagnostics are returned as data so tests can assert on them and the printing
// stays at the call site (see reportDiagnostics in diagnostics.ts). Unknown keys
// are warnings - never fatal, the config still works. A wrong value shape is an
// error: guessing what was meant is how "false" started dev servers.
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
  invoke: HerdrInvoker,
  env: Environment,
): Promise<{ config: TreehouseConfig; diagnostics: Diagnostic[] }> => {
  const path = configPath(invoke, env)
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
// the worktree.created hook. Pass the resolved repo name, or undefined when no
// single repo is in scope.
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
// the main checkout root.
export const resolveRepoConfig = async (
  mainRepoRoot: string,
  invoke: HerdrInvoker,
  env: Environment,
): Promise<{ name: string; config: RepoConfig; diagnostics: Diagnostic[] }> => {
  const { config: loaded, diagnostics } = await loadConfig(invoke, env)
  const entry = findRepoEntry(loaded.repos, mainRepoRoot)
  const name = entry?.[0] ?? basename(mainRepoRoot)
  let config: RepoConfig = { ...loaded.defaults, ...(entry?.[1] ?? {}), root: mainRepoRoot }

  const localPath = join(mainRepoRoot, LOCAL_CONFIG_FILE)
  if (existsSync(localPath)) {
    const local = validateLocalConfigFile(await parseToml(localPath), localPath)
    diagnostics.push(...local.diagnostics)
    config = { ...config, ...local.config, root: mainRepoRoot }
  }
  return { name, config, diagnostics: diagnosticsForRepo(diagnostics, entry?.[0]) }
}

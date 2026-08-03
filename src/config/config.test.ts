import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BASE,
  diagnosticsForRepo,
  renderProposedBlock,
  resolveAllRepoConfigs,
  validateConfigFile,
  validateLocalConfigFile,
} from './config.ts'
import { reportDiagnostics } from './diagnostics.ts'
import { expectRejection } from '../testing/expectRejection.ts'

const FILE = '/cfg/config.toml'

const validate = (toml: string) => validateConfigFile(Bun.TOML.parse(toml), FILE)

const errors = (toml: string) =>
  validate(toml).diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((d) => d.message)

const warnings = (toml: string) =>
  validate(toml).diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').map((d) => d.message)

describe('value shapes that used to crash or coerce', () => {
  test('single-bracket panes name the [[...]] fix instead of throwing a TypeError', () => {
    const found = errors(`
[repos.x]
root = "/tmp/x"
[repos.x.panes]
split = "down"
`)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('repos.x.panes in /cfg/config.toml')
    expect(found[0]).toContain('expected a list of tables, found a single table')
    expect(found[0]).toContain('[[repos.x.panes]]')
  })

  test('a string setup is reported, not run one character per command', () => {
    const { config, diagnostics } = validate(`
[repos.x]
root = "/tmp/x"
setup = "npm ci"
`)
    expect(diagnostics.map((d) => d.message)).toEqual([
      'repos.x.setup in /cfg/config.toml: expected a list of strings, found a string ("npm ci")',
    ])
    expect(config.repos.x.setup).toBeUndefined()
  })

  test('a string bootstrap is reported, not handed to flatMap', () => {
    const { config, diagnostics } = validate(`
[repos.x]
root = "/tmp/x"
bootstrap = "script.sh"
`)
    expect(diagnostics[0].severity).toBe('error')
    expect(diagnostics[0].message).toContain('expected a list of strings, found a string ("script.sh")')
    expect(config.repos.x.bootstrap).toBeUndefined()
  })

  test('a quoted boolean is rejected rather than coerced into a truthy autostart', () => {
    const { config, diagnostics } = validate(`
[repos.x]
root = "/tmp/x"
[[repos.x.panes]]
label = "dev"
command = "npm run dev"
autostart = "false"
`)
    expect(diagnostics[0].message).toBe(
      'repos.x.panes[0].autostart in /cfg/config.toml: expected a boolean (unquoted true or false), found a string ("false")',
    )
    // Dropped, not coerced: nothing downstream can read it as truthy.
    expect(config.repos.x.panes?.[0].autostart).toBeUndefined()
    expect(config.repos.x.panes?.[0].command).toBe('npm run dev')
  })

  test('a real TOML boolean survives', () => {
    const { config, diagnostics } = validate(`
[repos.x]
root = "/tmp/x"
[[repos.x.panes]]
autostart = true
`)
    expect(diagnostics).toEqual([])
    expect(config.repos.x.panes?.[0].autostart).toBe(true)
  })

  test('a non-string entry inside a list names its index', () => {
    expect(errors(`
[repos.x]
root = "/tmp/x"
setup = ["npm ci", 3]
`)[0]).toContain('expected a list of strings, found a list with a number (3) at index 1')
  })

  test('an unsupported split value is reported with the allowed ones', () => {
    expect(errors(`
[repos.x]
root = "/tmp/x"
[[repos.x.panes]]
split = "left"
`)[0]).toBe('repos.x.panes[0].split in /cfg/config.toml: expected one of "down", "right", found "left"')
  })

  test('a repo entry that is not a table is reported', () => {
    expect(errors('repos = { x = "nope" }')[0]).toBe(
      'repos.x in /cfg/config.toml: expected a table, found a string ("nope")',
    )
  })

  test('a non-table defaults is reported', () => {
    expect(errors('defaults = "claude"')[0]).toBe(
      'defaults in /cfg/config.toml: expected a table, found a string ("claude")',
    )
  })
})

describe('unknown keys stay non-fatal warnings that name the file', () => {
  test('at the top level', () => {
    const found = warnings('agent = "claude"')
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('unknown key "agent" in the top level of /cfg/config.toml')
    expect(found[0]).toContain('Known keys: defaults, repos')
  })

  test('in [defaults]', () => {
    expect(warnings(`
[defaults]
agnet = "claude"
`)[0]).toContain('unknown key "agnet" in [defaults] in /cfg/config.toml')
  })

  test('in a repo block', () => {
    expect(warnings(`
[repos.x]
root = "/tmp/x"
dev_command = "npm run dev"
`)[0]).toContain('unknown key "dev_command" in [repos.x] in /cfg/config.toml')
  })

  test('in a pane table', () => {
    expect(warnings(`
[repos.x]
root = "/tmp/x"
[[repos.x.panes]]
auto_start = false
`)[0]).toContain('unknown key "auto_start" in [repos.x.panes[0]] in /cfg/config.toml')
  })

  test('and the surrounding config still loads', () => {
    const { config } = validate(`
[repos.x]
root = "/tmp/x"
dev_command = "npm run dev"
setup = ["npm ci"]
`)
    expect(config.repos.x.setup).toEqual(['npm ci'])
    expect('dev_command' in config.repos.x).toBe(false)
  })
})

describe('the shipped example config', () => {
  test('validates without a single diagnostic', async () => {
    const path = new URL('../../config.example.toml', import.meta.url).pathname
    const { config, diagnostics } = validateConfigFile(Bun.TOML.parse(await Bun.file(path).text()), path)
    expect(diagnostics).toEqual([])
    expect(config.repos['my-awesome-repo'].panes).toHaveLength(2)
    expect(config.repos['my-awesome-repo'].bootstrap?.[0]).toContain('worktree-up.sh')
  })
})

describe('the proposed onboarding block', () => {
  // The block onboard writes to the user's real config gets the same guarantee
  // as the shipped example: it must satisfy the validators it will be read by.
  const proposal = { name: 'my-repo', root: '/dev/my-repo', installCommand: 'npm ci', devCommand: 'npm run dev' }

  test('round-trips through the central validator with zero diagnostics', () => {
    const { config, diagnostics } = validate(renderProposedBlock(proposal, 'central'))
    expect(diagnostics).toEqual([])
    expect(config.repos['my-repo'].root).toBe('/dev/my-repo')
    expect(config.repos['my-repo'].setup).toEqual(['npm ci'])
    expect(config.repos['my-repo'].panes?.[0].command).toBe('npm run dev')
  })

  test('round-trips through the local validator with zero diagnostics', () => {
    const { config, diagnostics } = validateLocalConfigFile(
      Bun.TOML.parse(renderProposedBlock(proposal, 'local')),
      '/repo/.treehouse.toml',
    )
    expect(diagnostics).toEqual([])
    expect(config.setup).toEqual(['npm ci'])
    expect(config.panes?.[0].autostart).toBe(false)
  })

  test('the commented examples uncomment into valid keys carrying the real defaults', () => {
    // A scan that learned nothing renders every optional line commented; those
    // lines must be one '#' away from config the validator accepts, with the
    // defaults the engine actually applies.
    const block = renderProposedBlock({ name: 'my-repo', root: '/dev/my-repo' }, 'central')
    const uncommented = block
      .split('\n')
      .map((line) => line.replace(/^# (?=(worktree_dir|base|bootstrap|setup|command) )/, ''))
      .join('\n')
    const { config, diagnostics } = validate(uncommented)
    expect(diagnostics).toEqual([])
    expect(config.repos['my-repo'].worktree_dir).toBe('../my-repo-{id}')
    expect(config.repos['my-repo'].base).toBe(DEFAULT_BASE)
    expect(config.repos['my-repo'].setup).toEqual(['npm ci'])
  })

  test('a dotted repo name is quoted so the block still parses', () => {
    const { config, diagnostics } = validate(
      renderProposedBlock({ ...proposal, name: 'my.repo' }, 'central'),
    )
    expect(diagnostics).toEqual([])
    expect(config.repos['my.repo'].root).toBe('/dev/my-repo')
  })

  test('a name and root that are not TOML-safe are escaped, not interpolated raw', () => {
    // A space is not a bare-key character, and a quote in the path would end
    // the root string early; either used to render TOML the engine then
    // refuses to load.
    const { config, diagnostics } = validate(
      renderProposedBlock({ ...proposal, name: 'my repo', root: '/dev/my "repo"' }, 'central'),
    )
    expect(diagnostics).toEqual([])
    expect(config.repos['my repo'].root).toBe('/dev/my "repo"')
  })
})

describe('repo-local .treehouse.toml', () => {
  test('takes the repo fields without the wrapper', () => {
    const { config, diagnostics } = validateLocalConfigFile(
      Bun.TOML.parse(`
base = "origin/main"
setup = ["bun install"]
[[panes]]
split = "down"
label = "test"
`),
      '/repo/.treehouse.toml',
    )
    expect(diagnostics).toEqual([])
    expect(config.base).toBe('origin/main')
    expect(config.panes?.[0].label).toBe('test')
  })

  test('warns that root is ignored', () => {
    const { diagnostics } = validateLocalConfigFile(
      Bun.TOML.parse('root = "/elsewhere"'),
      '/repo/.treehouse.toml',
    )
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: '"root" in /repo/.treehouse.toml is ignored (the repo root is where the file lives)',
      },
    ])
  })

  test('reports value shapes against the local file', () => {
    const { diagnostics } = validateLocalConfigFile(
      Bun.TOML.parse('setup = "npm ci"'),
      '/repo/.treehouse.toml',
    )
    expect(diagnostics[0].message).toBe(
      'setup in /repo/.treehouse.toml: expected a list of strings, found a string ("npm ci")',
    )
  })

  test('single-bracket panes name [[panes]] for the local shape', () => {
    const { diagnostics } = validateLocalConfigFile(
      Bun.TOML.parse('[panes]\nsplit = "down"\n'),
      '/repo/.treehouse.toml',
    )
    expect(diagnostics[0].message).toContain('[[panes]]')
  })
})

describe('context', () => {
  test('is accepted in [defaults] and in a repo block', () => {
    const { config, diagnostics } = validate(`
[defaults]
context = "every repo"

[repos.x]
root = "/tmp/x"
context = """
line one
line two
"""
`)
    expect(diagnostics).toEqual([])
    expect(config.defaults.context).toBe('every repo')
    // Stored as TOML handed it over, blank edges and all (Bun keeps the newline
    // after the """); trimming them is the rendering side's business.
    expect(config.repos.x.context).toBe('\nline one\nline two\n')
  })

  test('is accepted in a repo-local file', () => {
    const { config, diagnostics } = validateLocalConfigFile(
      Bun.TOML.parse('context = "just this repo"'),
      '/repo/.treehouse.toml',
    )
    expect(diagnostics).toEqual([])
    expect(config.context).toBe('just this repo')
  })

  test('a list is reported rather than reaching the renderer', () => {
    expect(errors('[repos.x]\nroot = "/tmp/x"\ncontext = ["a", "b"]\n')).toEqual([
      'repos.x.context in /cfg/config.toml: expected a string, found a list',
    ])
  })
})

describe('resolveAllRepoConfigs', () => {
  let parent: string
  let configDir: string
  let warned: string[]

  const warn = (message: string) => warned.push(message)

  const repoDir = (name: string) => {
    const dir = join(parent, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const writeCentral = (toml: string) => writeFileSync(join(configDir, 'config.toml'), toml)

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'treehouse-config-test-'))
    configDir = join(parent, 'config')
    mkdirSync(configDir)
    warned = []
  })

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })

  test('every central entry comes back with defaults and local file layered', async () => {
    const a = repoDir('a')
    const b = repoDir('b')
    writeFileSync(join(b, '.treehouse.toml'), 'base = "origin/main"\n')
    writeCentral(`
[defaults]
agent = "claude"

[repos.a]
root = ${JSON.stringify(a)}
agent = "codex"

[repos.b]
root = ${JSON.stringify(b)}
base = "origin/master"
`)
    const resolved = await resolveAllRepoConfigs(configDir, warn)
    expect(resolved.map((entry) => entry.name)).toEqual(['a', 'b'])
    expect(resolved[0].config.agent).toBe('codex')
    expect(resolved[1].config.agent).toBe('claude')
    // The local file wins over the central block, as in resolveRepoConfig.
    expect(resolved[1].config.base).toBe('origin/main')
    expect(warned).toEqual([])
  })

  test('a repo context replaces the default rather than appending to it', async () => {
    const a = repoDir('a')
    const b = repoDir('b')
    const c = repoDir('c')
    writeFileSync(join(c, '.treehouse.toml'), 'context = "from the local file"\n')
    writeCentral(`
[defaults]
context = "from defaults"

[repos.a]
root = ${JSON.stringify(a)}

[repos.b]
root = ${JSON.stringify(b)}
context = "from the repo block"

[repos.c]
root = ${JSON.stringify(c)}
context = "from the repo block"
`)
    const resolved = await resolveAllRepoConfigs(configDir, warn)
    expect(resolved.map((entry) => entry.config.context)).toEqual([
      'from defaults',
      'from the repo block',
      'from the local file',
    ])
  })

  test('a repo with a broken block is skipped with a demoted warning, the rest resolve', async () => {
    const a = repoDir('a')
    writeCentral(`
[repos.a]
root = ${JSON.stringify(a)}

[repos.broken]
root = "/tmp/broken"
setup = "npm ci"
`)
    const resolved = await resolveAllRepoConfigs(configDir, warn)
    expect(resolved.map((entry) => entry.name)).toEqual(['a'])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('repos.broken.setup')
    expect(warned[0]).toContain('(repo skipped here)')
  })

  test('an unknown key in a repo block still warns in the listing', async () => {
    const a = repoDir('a')
    writeCentral(`
[repos.a]
root = ${JSON.stringify(a)}
setpu = ["npm ci"]
`)
    const resolved = await resolveAllRepoConfigs(configDir, warn)
    expect(resolved.map((entry) => entry.name)).toEqual(['a'])
    expect(warned.some((message) => message.includes('unknown key "setpu"'))).toBe(true)
  })

  test('an empty or relative root is skipped with a warning, never resolved against cwd', async () => {
    const a = repoDir('a')
    writeCentral(`
[repos.empty]
root = ""

[repos.relative]
root = "../somewhere"

[repos.a]
root = ${JSON.stringify(a)}
`)
    const resolved = await resolveAllRepoConfigs(configDir, warn)
    expect(resolved.map((entry) => entry.name)).toEqual(['a'])
    // Two per bad repo: the rejected value, then the required key it left
    // unfilled, the same pair a wrong-typed root has always produced.
    expect(warned).toHaveLength(4)
    expect(warned[0]).toContain('repos.empty.root')
    expect(warned[0]).toContain('expected an absolute path, found ""')
    expect(warned[0]).toContain('(repo skipped here)')
    expect(warned[2]).toContain('repos.relative.root')
    expect(warned[2]).toContain('expected an absolute path, found "../somewhere"')
  })

  test('a repo with a broken local file is skipped with a warning', async () => {
    const a = repoDir('a')
    writeFileSync(join(a, '.treehouse.toml'), 'setup = "npm ci"\n')
    writeCentral(`[repos.a]\nroot = ${JSON.stringify(a)}\n`)
    const resolved = await resolveAllRepoConfigs(configDir, warn)
    expect(resolved).toEqual([])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('skipping a')
  })

  test('no config file at all is an empty listing, not an error', async () => {
    expect(await resolveAllRepoConfigs(configDir, warn)).toEqual([])
    expect(warned).toEqual([])
  })

  test('an error outside the repo blocks still stops the run', async () => {
    writeCentral('[defaults]\nagent = 3\n')
    await expectRejection(resolveAllRepoConfigs(configDir, warn), 'invalid config')
  })
})

describe('reportDiagnostics', () => {
  test('prints warnings and continues', () => {
    const printed: string[] = []
    reportDiagnostics([{ severity: 'warning', message: 'unknown key "x"' }], (m) => printed.push(m))
    expect(printed).toEqual(['warning: unknown key "x"'])
  })

  test('throws on errors, listing them all', () => {
    expect(() =>
      reportDiagnostics(
        [
          { severity: 'warning', message: 'unknown key "x"' },
          { severity: 'error', message: 'first' },
          { severity: 'error', message: 'second' },
        ],
        () => {},
      ),
    ).toThrow('invalid config:\n  first\n  second')
  })
})

describe('a [repos.X] block without root', () => {
  // realpathSync('') resolves to the process cwd, so an empty or missing root
  // would make the block claim whichever repo you happened to run from.
  test('is an error naming the missing key', () => {
    const found = errors(`
[repos.x]
base = "origin/main"
`)
    expect(found).toEqual(['[repos.x] in /cfg/config.toml: missing required key "root"'])
  })

  test('and a wrong-typed root is reported once, as a type error', () => {
    expect(errors('repos = { x = { root = 3 } }')).toEqual([
      'repos.x.root in /cfg/config.toml: expected a string, found a number (3)',
      '[repos.x] in /cfg/config.toml: missing required key "root"',
    ])
  })

  test('a repo-local file still needs no root', () => {
    const { diagnostics } = validateLocalConfigFile(Bun.TOML.parse('base = "origin/main"'), '/repo/.treehouse.toml')
    expect(diagnostics).toEqual([])
  })
})

describe('root must be an absolute path', () => {
  test('an empty root is an error, not a block that claims the cwd', () => {
    expect(errors('[repos.x]\nroot = ""\n')).toEqual([
      'repos.x.root in /cfg/config.toml: expected an absolute path, found ""',
      '[repos.x] in /cfg/config.toml: missing required key "root"',
    ])
  })

  test('a relative root is an error', () => {
    expect(errors('[repos.x]\nroot = "../somewhere"\n')[0]).toBe(
      'repos.x.root in /cfg/config.toml: expected an absolute path, found "../somewhere"',
    )
  })

  test('a ~ root is expanded before the check, not rejected', () => {
    const { config, diagnostics } = validate('[repos.x]\nroot = "~/dev/x"\n')
    expect(diagnostics).toEqual([])
    // Stored unexpanded; expansion happens where the path is used.
    expect(config.repos.x.root).toBe('~/dev/x')
  })

  test('the error is scoped to the repo, so it demotes and skips like any other', () => {
    const { diagnostics } = validate('[repos.x]\nroot = "relative"\n')
    expect(diagnostics[0].key).toBe('repos.x.root')
    expect(diagnosticsForRepo(diagnostics, 'other')[0].severity).toBe('warning')
  })
})

describe('diagnosticsForRepo', () => {
  const diagnostics = [
    { severity: 'error' as const, key: 'repos.mine.setup', message: 'mine is broken' },
    { severity: 'error' as const, key: 'repos.other.setup', message: 'other is broken' },
    { severity: 'error' as const, key: 'defaults.agent', message: 'defaults is broken' },
    { severity: 'warning' as const, key: 'repos.other.nope', message: 'unknown key' },
  ]

  test('keeps errors for this repo and for shared blocks fatal', () => {
    const scoped = diagnosticsForRepo(diagnostics, 'mine')
    expect(scoped[0]).toEqual(diagnostics[0])
    expect(scoped[2]).toEqual(diagnostics[2])
  })

  test('demotes another repo\'s errors, so one bad block cannot break every command', () => {
    const scoped = diagnosticsForRepo(diagnostics, 'mine')
    expect(scoped[1].severity).toBe('warning')
    expect(scoped[1].message).toContain("another repo's block, ignored here")
  })

  test('with no repo in scope, every repo-scoped error is demoted', () => {
    const scoped = diagnosticsForRepo(diagnostics, undefined)
    expect(scoped.filter((d) => d.severity === 'error').map((d) => d.key)).toEqual(['defaults.agent'])
  })

  test('leaves warnings alone', () => {
    expect(diagnosticsForRepo(diagnostics, 'mine')[3]).toEqual(diagnostics[3])
  })

  test('a repo whose name merely starts with mine is still another repo', () => {
    const scoped = diagnosticsForRepo(
      [{ severity: 'error', key: 'repos.mine-too.setup', message: 'broken' }],
      'mine',
    )
    expect(scoped[0].severity).toBe('warning')
  })
})

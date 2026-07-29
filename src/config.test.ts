import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BASE,
  diagnosticsForRepo,
  renderProposedBlock,
  validateConfigFile,
  validateLocalConfigFile,
} from './config.ts'
import { reportDiagnostics } from './diagnostics.ts'

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
    const path = new URL('../config.example.toml', import.meta.url).pathname
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
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderProposedBlock, resolveAllRepoConfigs, resolveRepoConfig } from './config.ts'
import { reportDiagnostics } from './diagnostics.ts'
import { expectRejection } from '../testing/expectRejection.ts'

// Driven through the two resolvers, which is the interface every call site uses:
// a temp config dir for the central file, real directories for the repos (a
// [repos.X] block is matched by path identity), and a warn sink for the
// diagnostics. Validation is reached the way a command reaches it.

let parent: string
let configDir: string
let centralPath: string
// The repo under test, named the way its config key is, so a diagnostic scoped
// to it stays fatal instead of demoting to "another repo's block".
let mine: string
let warned: string[]

const warn = (message: string) => warned.push(message)

const repoDir = (name: string) => {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const localPath = (repoRoot: string) => join(repoRoot, '.treehouse.toml')

const writeCentral = (toml: string) => writeFileSync(centralPath, toml)

const writeLocal = (repoRoot: string, toml: string) => writeFileSync(localPath(repoRoot), toml)

// The central config as one [repos.my-repo] block for the repo under test.
const writeMyBlock = (body: string) =>
  writeCentral(`[repos.my-repo]\nroot = ${JSON.stringify(mine)}\n${body}`)

const resolveMine = () => resolveRepoConfig(mine, configDir, warn)

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'treehouse-config-test-'))
  configDir = join(parent, 'config')
  mkdirSync(configDir)
  centralPath = join(configDir, 'config.toml')
  mine = repoDir('my-repo')
  warned = []
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

describe('resolving one repo', () => {
  test('layers [defaults], the repo block and the local file, highest last', async () => {
    writeLocal(mine, 'agent = "claude --resume"\n')
    writeCentral(`
[defaults]
agent = "claude"
context = "from defaults"
model_arg = "--model {model}"

[repos.my-repo]
root = ${JSON.stringify(mine)}
base = "origin/main"
context = "from the repo block"
`)
    const { name, config } = await resolveMine()
    expect(name).toBe('my-repo')
    expect(config.agent).toBe('claude --resume')
    expect(config.context).toBe('from the repo block')
    expect(config.model_arg).toBe('--model {model}')
    expect(config.base).toBe('origin/main')
    expect(config.root).toBe(mine)
    expect(warned).toEqual([])
  })

  test('the keys with a default are present even when nothing declares them', async () => {
    const { config } = await resolveMine()
    expect(config.base).toBe('origin/master')
    expect(config.worktree_dir).toBe('../{repo}-{id}')
    expect(config.panes).toEqual([])
  })

  test('a key with no default stays absent, so "not configured" is still readable', async () => {
    const { config } = await resolveMine()
    expect(config.bootstrap).toBeUndefined()
    expect(config.setup).toBeUndefined()
    expect(config.agent).toBeUndefined()
    expect(config.context).toBeUndefined()
    expect(config.model_arg).toBeUndefined()
  })

  test('a pane gets the documented defaults per entry, keeping what it declares', async () => {
    writeLocal(mine, `
[[panes]]
label = "dev"
command = "npm run dev"

[[panes]]
split = "right"
ratio = 0.3
autostart = true
`)
    const { config } = await resolveMine()
    expect(config.panes[0]).toEqual({
      split: 'down',
      ratio: 0.5,
      label: 'dev',
      command: 'npm run dev',
      autostart: false,
    })
    expect(config.panes[1]).toEqual({ split: 'right', ratio: 0.3, autostart: true })
  })

  test('an unknown key warns and the rest of the config still resolves', async () => {
    writeMyBlock('dev_command = "npm run dev"\nsetup = ["npm ci"]\n')
    const { config } = await resolveMine()
    expect(config.setup).toEqual(['npm ci'])
    expect('dev_command' in config).toBe(false)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('unknown key "dev_command" in [repos.my-repo]')
  })

  test('a wrong value shape stops the run instead of resolving', async () => {
    writeMyBlock('setup = "npm ci"\n')
    await expectRejection(
      resolveMine(),
      `repos.my-repo.setup in ${centralPath}: expected a list of strings, found a string ("npm ci")`,
    )
  })

  test('another repo\'s broken block is demoted to a warning, so work here continues', async () => {
    writeCentral(`
[repos.my-repo]
root = ${JSON.stringify(mine)}

[repos.broken]
root = "/nowhere/at/all"
setup = "npm ci"
`)
    const { config } = await resolveMine()
    expect(config.base).toBe('origin/master')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('repos.broken.setup')
    expect(warned[0]).toContain("another repo's block, ignored here")
  })

  test('a repo whose key merely starts with this one\'s is still another repo', async () => {
    writeCentral(`
[repos.my-repo]
root = ${JSON.stringify(mine)}

[repos.my-repo-too]
root = "/nowhere/at/all"
setup = "npm ci"
`)
    await resolveMine()
    expect(warned[0]).toContain("another repo's block, ignored here")
  })

  test('a block that broke its own root cannot demote itself to another repo\'s', async () => {
    // `root` is the match key, so a block that lost it matches nothing; the
    // directory-name fallback keeps its errors fatal here instead of letting the
    // repo run unconfigured.
    writeCentral('[repos.my-repo]\nsetup = "npm ci"\n')
    await expectRejection(resolveMine(), 'expected a list of strings')
  })

  test('an error outside any repo block stops the run whichever repo asked', async () => {
    writeCentral('[defaults]\nagent = 3\n')
    await expectRejection(
      resolveMine(),
      `defaults.agent in ${centralPath}: expected a string, found a number (3)`,
    )
  })

  test('no central config at all is a repo with nothing but the defaults', async () => {
    const { name, config } = await resolveRepoConfig(repoDir('unconfigured'), configDir, warn)
    expect(name).toBe('unconfigured')
    expect(config.base).toBe('origin/master')
    expect(warned).toEqual([])
  })

  test('a repo known only by its local file resolves under its directory name', async () => {
    const lonely = repoDir('lonely')
    writeLocal(lonely, 'base = "origin/main"\nsetup = ["bun install"]\n')
    const { name, config } = await resolveRepoConfig(lonely, configDir, warn)
    expect(name).toBe('lonely')
    expect(config.base).toBe('origin/main')
    expect(config.setup).toEqual(['bun install'])
    expect(warned).toEqual([])
  })

  test('a block keyed differently from the directory still configures it, by root', async () => {
    writeCentral(`[repos.work-repo]\nroot = ${JSON.stringify(mine)}\nbase = "origin/main"\n`)
    const { name, config } = await resolveMine()
    expect(name).toBe('work-repo')
    expect(config.base).toBe('origin/main')
  })
})

describe('value shapes that used to crash or coerce', () => {
  test('single-bracket panes name the [[...]] fix instead of throwing a TypeError', async () => {
    writeCentral(`
[repos.my-repo]
root = ${JSON.stringify(mine)}
[repos.my-repo.panes]
split = "down"
`)
    await expectRejection(
      resolveMine(),
      'expected a list of tables, found a single table. Write [[repos.my-repo.panes]]',
    )
  })

  test('a string setup is reported against the file it came from, not run per character', async () => {
    writeLocal(mine, 'setup = "npm ci"\n')
    await expectRejection(
      resolveMine(),
      `setup in ${localPath(mine)}: expected a list of strings, found a string ("npm ci")`,
    )
  })

  test('a string bootstrap is reported, not handed to flatMap', async () => {
    writeLocal(mine, 'bootstrap = "script.sh"\n')
    await expectRejection(resolveMine(), 'expected a list of strings, found a string ("script.sh")')
  })

  test('a quoted boolean is rejected rather than coerced into a truthy autostart', async () => {
    // Coercing is what started dev servers that must not race, so the run stops
    // here rather than resolving a pane with a value nobody meant.
    writeLocal(mine, '[[panes]]\nlabel = "dev"\ncommand = "npm run dev"\nautostart = "false"\n')
    await expectRejection(
      resolveMine(),
      'panes[0].autostart in ' +
        `${localPath(mine)}: expected a boolean (unquoted true or false), found a string ("false")`,
    )
  })

  test('a real TOML boolean survives', async () => {
    writeLocal(mine, '[[panes]]\nautostart = true\n')
    const { config } = await resolveMine()
    expect(config.panes[0].autostart).toBe(true)
    expect(warned).toEqual([])
  })

  test('a non-string entry inside a list names its index', async () => {
    writeLocal(mine, 'setup = ["npm ci", 3]\n')
    await expectRejection(
      resolveMine(),
      'expected a list of strings, found a list with a number (3) at index 1',
    )
  })

  test('an unsupported split value is reported with the allowed ones', async () => {
    writeLocal(mine, '[[panes]]\nsplit = "left"\n')
    await expectRejection(
      resolveMine(),
      `panes[0].split in ${localPath(mine)}: expected one of "down", "right", found "left"`,
    )
  })

  test('a repo entry that is not a table is reported', async () => {
    const x = repoDir('x')
    writeCentral('repos = { x = "nope" }')
    await expectRejection(
      resolveRepoConfig(x, configDir, warn),
      `repos.x in ${centralPath}: expected a table, found a string ("nope")`,
    )
  })

  test('a non-table defaults is reported', async () => {
    writeCentral('defaults = "claude"')
    await expectRejection(
      resolveMine(),
      `defaults in ${centralPath}: expected a table, found a string ("claude")`,
    )
  })
})

describe('unknown keys stay non-fatal warnings that name the file', () => {
  test('at the top level', async () => {
    writeCentral('agent = "claude"')
    await resolveMine()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(`unknown key "agent" in the top level of ${centralPath}`)
    expect(warned[0]).toContain('Known keys: defaults, repos')
  })

  test('in [defaults]', async () => {
    writeCentral('[defaults]\nagnet = "claude"\n')
    await resolveMine()
    expect(warned[0]).toContain(`unknown key "agnet" in [defaults] in ${centralPath}`)
  })

  test('in a pane table', async () => {
    writeLocal(mine, '[[panes]]\nauto_start = false\n')
    await resolveMine()
    expect(warned[0]).toContain(`unknown key "auto_start" in [panes[0]] in ${localPath(mine)}`)
  })
})

describe('the shipped example config', () => {
  test('resolves without a single diagnostic', async () => {
    copyFileSync(new URL('../../config.example.toml', import.meta.url).pathname, centralPath)
    const resolved = await resolveAllRepoConfigs(configDir, warn)
    expect(warned).toEqual([])
    expect(resolved.map((entry) => entry.name)).toEqual(['my-awesome-repo'])
    expect(resolved[0].config.panes).toHaveLength(2)
    expect(resolved[0].config.bootstrap?.[0]).toContain('worktree-up.sh')
  })
})

describe('the proposed onboarding block', () => {
  // The block onboard writes to the user's real config gets the same guarantee
  // as the shipped example: it must resolve, through the validators it will be
  // read by, without a diagnostic.
  const proposal = { name: 'my-repo', root: '', installCommand: 'npm ci', devCommand: 'npm run dev' }

  test('round-trips through central resolution with zero diagnostics', async () => {
    writeCentral(renderProposedBlock({ ...proposal, root: mine }, 'central'))
    const { name, config } = await resolveMine()
    expect(warned).toEqual([])
    expect(name).toBe('my-repo')
    expect(config.root).toBe(mine)
    expect(config.setup).toEqual(['npm ci'])
    expect(config.panes[0].command).toBe('npm run dev')
  })

  test('round-trips through local resolution with zero diagnostics', async () => {
    writeLocal(mine, renderProposedBlock({ ...proposal, root: mine }, 'local'))
    const { config } = await resolveMine()
    expect(warned).toEqual([])
    expect(config.setup).toEqual(['npm ci'])
    expect(config.panes[0].autostart).toBe(false)
  })

  test('the commented lines uncomment into the very defaults the resolver applies', async () => {
    // A scan that learned nothing renders every optional line commented; those
    // lines must be one '#' away from config the validator accepts, carrying the
    // values the engine would have filled in anyway.
    const block = renderProposedBlock({ name: 'my-repo', root: mine }, 'central')
    writeCentral(block)
    const commented = await resolveMine()
    writeCentral(
      block
        .split('\n')
        .map((line) => line.replace(/^# (?=(worktree_dir|base|bootstrap|setup|command) )/, ''))
        .join('\n'),
    )
    const uncommented = await resolveMine()

    expect(warned).toEqual([])
    expect(uncommented.config.base).toBe(commented.config.base)
    // Advertised with {repo} already filled in, since the block names one repo.
    expect(uncommented.config.worktree_dir).toBe(
      commented.config.worktree_dir.replace('{repo}', 'my-repo'),
    )
    expect(uncommented.config.setup).toEqual(['npm ci'])
  })

  test('the pane it renders spells out the defaults a bare pane would get', async () => {
    const bare = repoDir('bare')
    writeLocal(bare, '[[panes]]\n')
    const defaultPane = (await resolveRepoConfig(bare, configDir, warn)).config.panes[0]

    writeCentral(renderProposedBlock({ name: 'my-repo', root: mine }, 'central'))
    const rendered = (await resolveMine()).config.panes[0]
    expect(rendered.split).toBe(defaultPane.split)
    expect(rendered.autostart).toBe(defaultPane.autostart)
  })

  test('a dotted repo name is quoted so the block still parses', async () => {
    writeCentral(renderProposedBlock({ ...proposal, name: 'my.repo', root: mine }, 'central'))
    const { name } = await resolveMine()
    expect(warned).toEqual([])
    expect(name).toBe('my.repo')
  })

  test('a name and root that are not TOML-safe are escaped, not interpolated raw', async () => {
    // A space is not a bare-key character, and a quote in the path would end the
    // root string early; either used to render TOML the engine then refuses to
    // load, or a block that matches no checkout.
    const quoted = repoDir('my "repo"')
    writeCentral(renderProposedBlock({ ...proposal, name: 'my repo', root: quoted }, 'central'))
    const { name, config } = await resolveRepoConfig(quoted, configDir, warn)
    expect(warned).toEqual([])
    expect(name).toBe('my repo')
    expect(config.setup).toEqual(['npm ci'])
  })
})

describe('repo-local .treehouse.toml', () => {
  test('takes the repo fields without the wrapper', async () => {
    writeLocal(mine, `
base = "origin/main"
setup = ["bun install"]
[[panes]]
split = "down"
label = "test"
`)
    const { config } = await resolveMine()
    expect(warned).toEqual([])
    expect(config.base).toBe('origin/main')
    expect(config.panes[0].label).toBe('test')
  })

  test('warns that root is ignored, and the repo stays where the file lives', async () => {
    writeLocal(mine, 'root = "/elsewhere"\n')
    const { config } = await resolveMine()
    expect(warned).toEqual([
      `warning: "root" in ${localPath(mine)} is ignored (the repo root is where the file lives)`,
    ])
    expect(config.root).toBe(mine)
  })

  test('single-bracket panes name [[panes]] for the local shape', async () => {
    writeLocal(mine, '[panes]\nsplit = "down"\n')
    await expectRejection(resolveMine(), '[[panes]]')
  })

  test('wins over the central block, key by key', async () => {
    writeMyBlock('base = "origin/master"\nsetup = ["npm ci"]\n')
    writeLocal(mine, 'base = "origin/main"\n')
    const { config } = await resolveMine()
    expect(config.base).toBe('origin/main')
    expect(config.setup).toEqual(['npm ci'])
  })
})

describe('context', () => {
  test('is accepted in [defaults] and in a repo block', async () => {
    writeCentral(`
[defaults]
context = "every repo"

[repos.my-repo]
root = ${JSON.stringify(mine)}
context = """
line one
line two
"""
`)
    const { config } = await resolveMine()
    expect(warned).toEqual([])
    // Kept as TOML handed it over, blank edges and all (Bun keeps the newline
    // after the """); trimming them is the rendering side's business.
    expect(config.context).toBe('\nline one\nline two\n')
  })

  test('is accepted in a repo-local file', async () => {
    writeLocal(mine, 'context = "just this repo"\n')
    expect((await resolveMine()).config.context).toBe('just this repo')
  })

  test('a list is reported rather than reaching the renderer', async () => {
    writeLocal(mine, 'context = ["a", "b"]\n')
    await expectRejection(
      resolveMine(),
      `context in ${localPath(mine)}: expected a string, found a list`,
    )
  })
})

describe('a [repos.X] block without root', () => {
  // realpathSync('') resolves to the process cwd, so an empty or missing root
  // would make the block claim whichever repo you happened to run from.
  test('is an error naming the missing key', async () => {
    writeCentral('[repos.my-repo]\nbase = "origin/main"\n')
    await expectRejection(resolveMine(), `[repos.my-repo] in ${centralPath}: missing required key "root"`)
  })

  test('and a wrong-typed root is reported as a type error too', async () => {
    writeCentral('repos = { "my-repo" = { root = 3 } }')
    await expectRejection(
      resolveMine(),
      `repos.my-repo.root in ${centralPath}: expected a string, found a number (3)`,
    )
  })

  test('a repo-local file still needs no root', async () => {
    writeLocal(mine, 'base = "origin/main"\n')
    await resolveMine()
    expect(warned).toEqual([])
  })
})

describe('root must be an absolute path', () => {
  test('an empty root is an error, not a block that claims the cwd', async () => {
    writeCentral('[repos.my-repo]\nroot = ""\n')
    await expectRejection(
      resolveMine(),
      `repos.my-repo.root in ${centralPath}: expected an absolute path, found ""`,
    )
  })

  test('a relative root is an error', async () => {
    writeCentral('[repos.my-repo]\nroot = "../somewhere"\n')
    await expectRejection(resolveMine(), 'expected an absolute path, found "../somewhere"')
  })

  test('a ~ root is expanded before the check, not rejected', async () => {
    // Expanded where it is used, so the repo it claims is the one under ~.
    writeCentral('[repos.elsewhere]\nroot = "~/dev/elsewhere"\n')
    const resolved = await resolveAllRepoConfigs(configDir, warn)
    expect(warned).toEqual([])
    expect(resolved[0].config.root).toBe(join(homedir(), 'dev/elsewhere'))
  })
})

describe('the multi-repo view', () => {
  test('every central entry comes back with defaults and local file layered', async () => {
    const a = repoDir('a')
    const b = repoDir('b')
    writeLocal(b, 'base = "origin/main"\n')
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

  test('applies the same defaults as the single-repo resolver', async () => {
    const a = repoDir('a')
    writeCentral(`[repos.a]\nroot = ${JSON.stringify(a)}\n[[repos.a.panes]]\nlabel = "dev"\n`)
    const [{ config }] = await resolveAllRepoConfigs(configDir, warn)
    expect(config.base).toBe('origin/master')
    expect(config.worktree_dir).toBe('../{repo}-{id}')
    expect(config.panes[0]).toEqual({ split: 'down', ratio: 0.5, label: 'dev', autostart: false })
  })

  test('a repo context replaces the default rather than appending to it', async () => {
    const a = repoDir('a')
    const b = repoDir('b')
    const c = repoDir('c')
    writeLocal(c, 'context = "from the local file"\n')
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
    writeLocal(a, 'setup = "npm ci"\n')
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

  test('repos known only by a local file are invisible here, by design', async () => {
    writeLocal(repoDir('lonely'), 'base = "origin/main"\n')
    expect(await resolveAllRepoConfigs(configDir, warn)).toEqual([])
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

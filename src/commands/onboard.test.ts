import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { onboard } from './onboard.ts'
import { expectRejection } from '../testing/expectRejection.ts'
import { createFakeHerdr } from '../testing/fakeHerdr.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'

let repo: TempRepo
let configDir: string
let configFile: string
let originalCwd: string
let logged: string[]
let warned: string[]

beforeEach(() => {
  originalCwd = process.cwd()
  repo = createTempRepo('my-repo')
  configDir = join(repo.parent, 'config')
  mkdirSync(configDir, { recursive: true })
  configFile = join(configDir, 'config.toml')
  logged = []
  warned = []
  process.chdir(repo.root)
})

afterEach(() => {
  process.chdir(originalCwd)
  repo.cleanup()
})

// onboard still reads cwd from the process (it is about "the repo I am standing
// in"), but the config dir it targets is an injected env fact.
const deps = () => ({
  invoke: createFakeHerdr({}).invoke,
  env: { HERDR_PLUGIN_CONFIG_DIR: configDir },
  log: (message: string) => logged.push(message),
  warn: (message: string) => warned.push(message),
})

describe('onboard', () => {
  test('--apply --local writes a repo-local file', async () => {
    await onboard(['--apply', '--local'], deps())
    const written = await Bun.file(join(repo.root, '.treehouse.toml')).text()
    expect(written).toContain('[[panes]]')
    expect(written).not.toContain('root =')
  })

  test('--apply appends a central block naming the repo root', async () => {
    await onboard(['--apply'], deps())
    const written = await Bun.file(configFile).text()
    expect(written).toContain('[repos.my-repo]')
    expect(written).toContain(`root = "${repo.root}"`)
  })

  test('a dry run writes nothing', async () => {
    await onboard([], deps())
    expect(existsSync(configFile)).toBe(false)
    expect(existsSync(join(repo.root, '.treehouse.toml'))).toBe(false)
  })

  // A dry run writes no file, so the printed block is its entire product. It
  // used to be unassertable: the only thing a test could check was the absence
  // of a file, which says nothing about what the reader is asked to paste.
  test('a dry run emits the block it wants pasted, plus how to apply it', async () => {
    await onboard([], deps())
    const output = logged.join('\n')
    expect(output).toContain(`# Proposed config for my-repo (${configFile})`)
    expect(output).toContain('[repos.my-repo]')
    expect(output).toContain(`root = "${repo.root}"`)
    expect(output).toContain('[[repos.my-repo.panes]]')
    expect(output).toContain('autostart = false')
    expect(output).toContain('# - no package.json found; set the dev pane command manually')
    expect(output).toContain(`Run again with --apply to write this to ${configFile}`)
    expect(output).toContain('add --local to write .treehouse.toml in the repo instead')
  })

  test('--local proposes the wrapper-free shape and points back at the central config', async () => {
    await onboard(['--local'], deps())
    const output = logged.join('\n')
    expect(output).toContain('[[panes]]')
    expect(output).not.toContain('[repos.my-repo]')
    expect(output).not.toContain('root =')
    expect(output).toContain(`omit --local to target ${configFile} instead`)
  })

  // The duplicate check matches by root, the same way config resolution does: a
  // block keyed differently from the directory still configures this repo, and a
  // second block would leave two fighting over it.
  test('refuses when the repo is already configured under a different key', async () => {
    writeFileSync(configFile, `[repos.legacy-name]\nroot = "${repo.root}"\n`)
    await expectRejection(onboard(['--apply'], deps()), 'already configured as [repos.legacy-name]')
    expect(await Bun.file(configFile).text()).not.toContain('[repos.my-repo]')
  })

  test('refuses when the repo is already configured under its own name', async () => {
    writeFileSync(configFile, `[repos.my-repo]\nroot = "${repo.root}"\n`)
    await expectRejection(onboard(['--apply'], deps()), '"my-repo" is already configured in')
  })

  test('another repo\'s broken block does not block onboarding', async () => {
    writeFileSync(configFile, `[repos.other]\nroot = "/nowhere"\nsetup = "npm ci"\n`)
    await onboard(['--apply'], deps())
    expect(await Bun.file(configFile).text()).toContain('[repos.my-repo]')
    expect(warned.join('\n')).toContain("another repo's block, ignored here")
  })

  test('a broken block for this repo stops onboarding', async () => {
    writeFileSync(configFile, `[repos.my-repo]\nroot = "${repo.root}"\nsetup = "npm ci"\n`)
    await expectRejection(
      onboard(['--apply'], deps()),
      /invalid config:.*expected a list of strings/s,
    )
  })
})

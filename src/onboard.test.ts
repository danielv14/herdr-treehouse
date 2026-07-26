import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { onboard } from './onboard.ts'
import { expectRejection } from './testing/expectRejection.ts'
import { createFakeHerdr } from './testing/fakeHerdr.ts'
import { createTempRepo, type TempRepo } from './testing/tempRepo.ts'

let repo: TempRepo
let configDir: string
let configFile: string
let previousConfigDir: string | undefined
let originalCwd: string
let warned: string[]

beforeEach(() => {
  originalCwd = process.cwd()
  repo = createTempRepo('my-repo')
  configDir = join(repo.parent, 'config')
  mkdirSync(configDir, { recursive: true })
  configFile = join(configDir, 'config.toml')
  previousConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR
  process.env.HERDR_PLUGIN_CONFIG_DIR = configDir
  warned = []
  process.chdir(repo.root)
})

afterEach(() => {
  process.chdir(originalCwd)
  if (previousConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR
  else process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDir
  repo.cleanup()
})

const deps = () => ({ invoke: createFakeHerdr({}).invoke, warn: (message: string) => warned.push(message) })

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
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrapFromEvent } from './bootstrap.ts'
import type { Environment } from '../herdr/context.ts'
import type { EngineDeps } from '../deps.ts'
import type { ProcessRunner } from '../processRunner.ts'
import { expectRejection } from '../testing/expectRejection.ts'
import { createFakeHerdr } from '../testing/fakeHerdr.ts'
import { createFakeProcessRunner } from '../testing/fakeProcessRunner.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'

// The hook is the only path in the engine that runs unattended, driven by a
// payload another program owns, so every way that payload can disappoint it is
// worth a test.

let repo: TempRepo
let configDir: string
let worktree: string
let logged: string[]

// The payload as herdr 0.7.5 sends it, confirmed live in the plugin log.
const payload = (worktreePath: unknown, branch: unknown) =>
  JSON.stringify({
    event: 'worktree_created',
    data: {
      type: 'worktree_created',
      workspace: { workspace_id: 'wD', label: 'my-repo' },
      worktree: { path: worktreePath, branch, is_linked_worktree: true },
    },
  })

// `run` left out is the real spawn, which is what most of these tests assert
// through (a setup command that writes a file).
const deps = (env: Environment, run?: ProcessRunner): EngineDeps => ({
  invoke: createFakeHerdr({}).invoke,
  env: { HERDR_PLUGIN_CONFIG_DIR: configDir, ...env },
  run,
  warn: (message) => logged.push(message),
})

const runHook = (eventJson: string | undefined, run?: ProcessRunner) =>
  bootstrapFromEvent(deps(eventJson === undefined ? {} : { HERDR_PLUGIN_EVENT_JSON: eventJson }, run))

// Herdr's native worktree flow creates the checkout before the hook fires.
const createWorktreeLikeHerdrDoes = () => {
  repo.git('worktree', 'add', worktree, '-b', 'ABC-1/fix', '--no-track', 'master')
}

beforeEach(() => {
  repo = createTempRepo('my-repo')
  configDir = join(repo.parent, 'config')
  mkdirSync(configDir, { recursive: true })
  worktree = join(repo.parent, 'my-repo-hook')
  logged = []
})

afterEach(() => {
  repo.cleanup()
})

describe('a well-formed payload', () => {
  test('runs the setup commands of a repo configured with setup and no bootstrap', async () => {
    // The case sharing provisioning with `up` exists for: no bootstrap script,
    // so the hook path used to leave this repo without dependencies.
    writeFileSync(join(repo.root, '.treehouse.toml'), 'setup = ["echo ran > ran.txt"]\n')
    createWorktreeLikeHerdrDoes()

    await runHook(payload(worktree, 'ABC-1/fix'))

    expect(existsSync(join(worktree, 'ran.txt'))).toBe(true)
    expect(logged.join('\n')).toContain('setup: echo ran > ran.txt')
  })

  test('the setup commands go to the runner from deps, in the worktree Herdr made', async () => {
    // The hook is the unattended path, so the seam it provisions through gets
    // the same guard `up` has: a spawnSync import sneaking back into this call
    // site would leave every other test in this file green.
    writeFileSync(join(repo.root, '.treehouse.toml'), 'setup = ["npm ci"]\n')
    createWorktreeLikeHerdrDoes()
    const runner = createFakeProcessRunner()

    await runHook(payload(worktree, 'ABC-1/fix'), runner.run)

    expect(runner.commands()).toEqual(['bash -lc npm ci'])
    expect(runner.runsIn(worktree)).toHaveLength(1)
  })

  test('logs the raw payload, so the plugin log shows what Herdr sent', async () => {
    writeFileSync(join(repo.root, '.treehouse.toml'), 'setup = ["true"]\n')
    createWorktreeLikeHerdrDoes()
    const raw = payload(worktree, 'ABC-1/fix')

    await runHook(raw)

    expect(logged[0]).toBe(`event payload: ${raw}`)
  })

  test('runs the bootstrap script for the repos that have one', async () => {
    const script = join(repo.parent, 'bootstrap.sh')
    writeFileSync(script, '#!/usr/bin/env bash\necho bootstrapped > "$1/bootstrapped.txt"\n', { mode: 0o755 })
    writeFileSync(join(repo.root, '.treehouse.toml'), `bootstrap = ["${script}", "{worktree}"]\n`)
    createWorktreeLikeHerdrDoes()

    await runHook(payload(worktree, 'ABC-1/fix'))

    expect(existsSync(join(worktree, 'bootstrapped.txt'))).toBe(true)
  })
})

describe('a payload the hook cannot act on', () => {
  const expectNoOp = async (eventJson: string | undefined, expectedMessage: string) => {
    writeFileSync(join(repo.root, '.treehouse.toml'), 'setup = ["echo ran > ran.txt"]\n')
    createWorktreeLikeHerdrDoes()

    await runHook(eventJson)

    expect(existsSync(join(worktree, 'ran.txt'))).toBe(false)
    expect(logged.join('\n')).toContain(expectedMessage)
  }

  test('no payload at all is a no-op', async () => {
    await expectNoOp(undefined, 'no HERDR_PLUGIN_EVENT_JSON in environment, nothing to do')
  })

  test('a non-JSON payload is a no-op rather than a throw inside the hook', async () => {
    await expectNoOp('not json at all', 'could not find worktree path/branch in event payload')
  })

  test('JSON that is not an object is a no-op', async () => {
    await expectNoOp('"just a string"', 'could not find worktree path/branch in event payload')
  })

  test('a payload with no worktree path is a no-op', async () => {
    await expectNoOp(payload(undefined, 'ABC-1/fix'), 'could not find worktree path/branch in event payload')
  })

  test('a payload with no branch is a no-op', async () => {
    await expectNoOp(payload(worktree, undefined), 'could not find worktree path/branch in event payload')
  })

  test('a payload whose fields are the wrong type is a no-op', async () => {
    await expectNoOp(payload({ nested: true }, 42), 'could not find worktree path/branch in event payload')
  })

  test('a malformed payload is still logged raw, so the shape change is visible', async () => {
    await runHook('not json at all')
    expect(logged[0]).toBe('event payload: not json at all')
  })
})

describe('a repo the hook has nothing to do for', () => {
  test('an unconfigured repo is a no-op', async () => {
    createWorktreeLikeHerdrDoes()

    await runHook(payload(worktree, 'ABC-1/fix'))

    expect(logged.join('\n')).toContain('no bootstrap or setup configured for my-repo, skipping')
  })

  test('a broken block for another repo does not stop this one', async () => {
    writeFileSync(join(configDir, 'config.toml'), '[repos.elsewhere]\nroot = "/nowhere"\nsetup = "npm ci"\n')
    writeFileSync(join(repo.root, '.treehouse.toml'), 'setup = ["echo ran > ran.txt"]\n')
    createWorktreeLikeHerdrDoes()

    await runHook(payload(worktree, 'ABC-1/fix'))

    expect(logged.join('\n')).toContain("another repo's block, ignored here")
    expect(existsSync(join(worktree, 'ran.txt'))).toBe(true)
  })
})

describe('a broken block for this repo', () => {
  // The hook's tolerance ends at the payload seam: a failure while acting on a
  // well-formed payload is loud (a non-zero exit in the plugin log), because
  // silently skipping setup leaves a worktree that looks provisioned but is not.
  test('fails the hook loudly instead of provisioning without the config', async () => {
    writeFileSync(join(repo.root, '.treehouse.toml'), 'setup = "npm ci"\n')
    createWorktreeLikeHerdrDoes()

    await expectRejection(
      runHook(payload(worktree, 'ABC-1/fix')),
      /invalid config:.*expected a list of strings/s,
    )
    expect(existsSync(join(worktree, 'ran.txt'))).toBe(false)
  })
})

describe('a path that is not there any more', () => {
  // A well-formed payload can still point at a directory that has been removed
  // between the event and the hook. git() used to report that as a TypeError
  // from reading a null stderr.
  test('reports what actually failed', async () => {
    await expectRejection(
      runHook(payload(join(repo.parent, 'gone'), 'ABC-1/fix')),
      'git worktree list --porcelain failed in',
    )
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoConfig } from './config.ts'
import { buildWorktreePlan } from './plan.ts'
import { provisionWorktree, type ProvisionOptions } from './provision.ts'
import { createTempRepo, type TempRepo } from './testing/tempRepo.ts'

let repo: TempRepo
let logged: string[]
let warned: string[]

beforeEach(() => {
  repo = createTempRepo('my-repo')
  logged = []
  warned = []
})

afterEach(() => {
  repo.cleanup()
})

// Everything but the sinks: log and warn are required, so taking them here too
// would make every call site repeat them, and spreading `extra` last would let a
// test quietly replace the recording sinks while still asserting on `logged`.
type ProvisionExtras = Omit<ProvisionOptions, 'log' | 'warn'>

const options = (extra: ProvisionExtras = {}): ProvisionOptions => ({
  log: (message) => logged.push(message),
  warn: (message) => warned.push(message),
  ...extra,
})

const provision = (repoConfig: Partial<RepoConfig>, extra: ProvisionExtras = {}, branch = 'ABC-1/fix') => {
  const config: RepoConfig = { root: repo.root, base: 'master', ...repoConfig }
  const plan = buildWorktreePlan({
    repoName: repo.name,
    branch,
    mainRepoRoot: repo.root,
    repoConfig: config,
    targets: [],
    worktree: extra.worktreeState === 'just-created' ? join(repo.parent, 'my-repo-abc-1') : undefined,
  })
  return { plan, result: provisionWorktree(plan, config, options(extra)) }
}

// A stand-in bootstrap script: creates the worktree itself, like the real ones
// do, and records the argv it was handed.
const writeBootstrap = (name: string, body: string) => {
  const path = join(repo.parent, name)
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('git creation path', () => {
  test('creates the worktree and the branch, and reports it as created', () => {
    const { plan, result } = provision({})
    expect(existsSync(plan.worktree)).toBe(true)
    expect(result.created).toBe(true)
    expect(repo.git('worktree', 'list', '--porcelain')).toContain(plan.worktree)
    expect(repo.git('branch', '--list', 'ABC-1/fix').trim()).toContain('ABC-1/fix')
  })

  test('reuses an existing branch instead of recreating it', () => {
    repo.git('branch', 'ABC-1/fix')
    const { plan } = provision({})
    expect(existsSync(plan.worktree)).toBe(true)
  })

  test('a failed base-ref fetch degrades to a warning', () => {
    // A remote that cannot be reached, plus a local remote-tracking ref to
    // branch from: exactly the offline case.
    repo.git('remote', 'add', 'origin', join(repo.parent, 'does-not-exist.git'))
    repo.git('update-ref', 'refs/remotes/origin/master', 'HEAD')
    const { plan, result } = provision({ base: 'origin/master' })
    expect(existsSync(plan.worktree)).toBe(true)
    expect(result.created).toBe(true)
    expect(warned.join('\n')).toContain('could not fetch origin/master, branching from the local ref')
  })
})

describe('existing worktree', () => {
  test('re-running says so, skips setup and reports created: false', () => {
    const setup = { setup: ['echo ran >> ran.txt'] }
    const first = provision(setup)
    expect(first.result.setupRan).toBe(true)
    expect(readFileSync(join(first.plan.worktree, 'ran.txt'), 'utf8').trim()).toBe('ran')

    logged = []
    const second = provision(setup)
    expect(second.result).toEqual({ created: false, setupRan: false })
    expect(logged).toContain(`worktree already exists: ${second.plan.worktree}`)
    expect(logged).toContain(
      'worktree already existed; setup commands skipped (run them manually if deps are missing)',
    )
    // The setup command appends, so a second run would leave two lines.
    expect(readFileSync(join(second.plan.worktree, 'ran.txt'), 'utf8').trim()).toBe('ran')
  })
})

describe('setup', () => {
  test('runs in the worktree, in order, with placeholders expanded', () => {
    const { plan } = provision({
      setup: ['pwd > where.txt', 'echo {branch} {id} > what.txt', 'cp {root}/README.md copied.md'],
    })
    expect(readFileSync(join(plan.worktree, 'where.txt'), 'utf8').trim()).toBe(realpathSync(plan.worktree))
    expect(readFileSync(join(plan.worktree, 'what.txt'), 'utf8').trim()).toBe('ABC-1/fix abc-1')
    expect(existsSync(join(plan.worktree, 'copied.md'))).toBe(true)
    expect(logged).toContain('setup: pwd > where.txt')
  })

  test('a failing setup command stops the run and names the command', () => {
    expect(() => provision({ setup: ['exit 3'] })).toThrow('setup command failed (exit 3): exit 3')
  })
})

describe('bootstrap path', () => {
  test('replaces worktree creation and receives the expanded argv', () => {
    // argv is: --dir <worktree> <branch> [targets...]
    const script = writeBootstrap(
      'bootstrap.sh',
      'git worktree add "$2" -b "$3" --no-track master\necho "$@" > "$2/argv.txt"',
    )
    const { plan, result } = provision({
      bootstrap: [script, '--dir', '{worktree}', '{branch}', '{targets...}'],
    })
    expect(existsSync(plan.worktree)).toBe(true)
    expect(result.created).toBe(true)
    expect(readFileSync(join(plan.worktree, 'argv.txt'), 'utf8').trim()).toBe(
      `--dir ${plan.worktree} ABC-1/fix`,
    )
    expect(logged[0]).toContain(`bootstrap: ${script} --dir ${plan.worktree} ABC-1/fix`)
  })

  test('a bootstrap that does not produce the worktree fails loudly', () => {
    const script = writeBootstrap('noop.sh', 'true')
    expect(() => provision({ bootstrap: [script] })).toThrow(
      /bootstrap finished but worktree is missing/,
    )
  })

  test('a failing bootstrap fails the run', () => {
    const script = writeBootstrap('boom.sh', 'exit 4')
    expect(() => provision({ bootstrap: [script] })).toThrow('bootstrap failed (exit 4)')
  })

  test('setup still runs after a bootstrap created the worktree', () => {
    const script = writeBootstrap('bootstrap.sh', 'git worktree add "$2" -b "$3" --no-track master')
    const { plan, result } = provision({
      bootstrap: [script, '--dir', '{worktree}', '{branch}'],
      setup: ['echo ran > ran.txt'],
    })
    expect(result.setupRan).toBe(true)
    expect(existsSync(join(plan.worktree, 'ran.txt'))).toBe(true)
  })
})

describe('the worktree.created path', () => {
  // Herdr creates the checkout before the hook fires, so provisioning must not
  // try to create it - but it is still a fresh worktree, and setup has to run.
  const createWorktreeLikeHerdrDoes = () => {
    const path = join(repo.parent, 'my-repo-abc-1')
    repo.git('worktree', 'add', path, '-b', 'ABC-1/fix', '--no-track', 'master')
    return path
  }

  test('runs setup in a worktree someone else just created', () => {
    const worktree = createWorktreeLikeHerdrDoes()
    const { result } = provision({ setup: ['echo ran > ran.txt'] }, { worktreeState: 'just-created' })
    expect(result).toEqual({ created: true, setupRan: true })
    expect(existsSync(join(worktree, 'ran.txt'))).toBe(true)
    expect(logged).not.toContain(`worktree already exists: ${worktree}`)
  })

  test('runs the bootstrap too, for the repos that have one', () => {
    const worktree = createWorktreeLikeHerdrDoes()
    const script = writeBootstrap('bootstrap.sh', 'echo bootstrapped > "$2/bootstrapped.txt"')
    const { result } = provision(
      { bootstrap: [script, '--dir', '{worktree}'] },
      { worktreeState: 'just-created' },
    )
    expect(result.created).toBe(true)
    expect(existsSync(join(worktree, 'bootstrapped.txt'))).toBe(true)
  })
})

describe('an empty bootstrap list', () => {
  // `bootstrap = []` is truthy but has no argv[0]; spawning it crashed with a
  // Node type error. Treated as "no bootstrap configured" instead.
  test('creates the worktree with git instead of crashing', () => {
    const { plan, result } = provision({ bootstrap: [] })
    expect(existsSync(plan.worktree)).toBe(true)
    expect(result.created).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { RepoConfig } from '../config/config.ts'
import { buildWorktreePlan } from './plan.ts'
import { provisionWorktree, type ProvisionOptions } from './provision.ts'
import { resolvedRepoConfig } from '../testing/repoConfig.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'

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
  const config = resolvedRepoConfig({ root: repo.root, base: 'master', ...repoConfig })
  const plan = buildWorktreePlan({
    repoName: repo.name,
    branch,
    mainRepoRoot: repo.root,
    repoConfig: config,
    configDir: join(repo.parent, 'config'),
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
      'worktree already existed; setup commands skipped (re-run with --setup to run them here)',
    )
    // The setup command appends, so a second run would leave two lines.
    expect(readFileSync(join(second.plan.worktree, 'ran.txt'), 'utf8').trim()).toBe('ran')
  })
})

describe('a stray path where the worktree should go', () => {
  // git answers whether a worktree is already there, not existsSync: a leftover
  // directory used to read as "already exists", which skipped setup and opened a
  // tab on something that is not a checkout of the branch.
  const strayPath = () => join(repo.parent, 'my-repo-abc-1')

  test('a directory with files in it is refused, and setup does not run', () => {
    const stray = strayPath()
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, 'leftover.txt'), 'from a half-deleted worktree')

    expect(() => provision({ setup: ['echo ran > ran.txt'] })).toThrow(
      `${stray} is occupied by something git has no worktree for`,
    )
    expect(existsSync(join(stray, 'ran.txt'))).toBe(false)
    expect(repo.git('worktree', 'list', '--porcelain')).not.toContain(stray)
    expect(logged.join('\n')).not.toContain('worktree already exists')
  })

  test('a plain file at the path lands in the same refusal', () => {
    writeFileSync(strayPath(), 'not a checkout')
    expect(() => provision({})).toThrow('is occupied by something git has no worktree for')
  })

  test('a dangling symlink lands there too, though existsSync reads it as absent', () => {
    // git refuses a dangling link ("already exists"), so the guard lstats rather
    // than trusting existsSync, which follows the link and answers false.
    symlinkSync(join(repo.parent, 'nowhere'), strayPath())
    expect(existsSync(strayPath())).toBe(false)
    expect(() => provision({})).toThrow('is occupied by something git has no worktree for')
  })

  test('a bootstrap is exempt: it owns creation and may be handed the directory', () => {
    // The deliberate limit of the refusal above. A monorepo bootstrap is written
    // to tolerate a directory that is already there, so second-guessing it here
    // would break exactly the repos that need it.
    const stray = strayPath()
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, 'leftover.txt'), 'the script deals with this')
    const script = writeBootstrap(
      'bootstrap.sh',
      '[ -d "$2" ] || git worktree add "$2" -b "$3" --no-track master\necho handled >> "$2/bootstrap.txt"',
    )

    const { result } = provision({ bootstrap: [script, '--dir', '{worktree}', '{branch}'] })
    expect(readFileSync(join(stray, 'bootstrap.txt'), 'utf8').trim()).toBe('handled')
    expect(result.created).toBe(true)
  })

  test('a worktree git lists but whose directory is gone says which command clears it', () => {
    // git keeps listing a worktree removed by hand (`ls` renders it as missing).
    // Answering "already exists" and then "missing after creation" was two false
    // statements and no way forward.
    const stray = strayPath()
    repo.git('worktree', 'add', stray, '-b', 'ABC-1/fix', '--no-track', 'master')
    rmSync(stray, { recursive: true, force: true })

    const failure = expect(() => provision({}))
    failure.toThrow(`git still lists a worktree at ${stray}, but the directory is gone`)
    failure.toThrow('git worktree prune')
    expect(logged.join('\n')).not.toContain('worktree already exists')
  })

  test('an empty leftover directory is still taken over by git', () => {
    // `git worktree add` checks a worktree out into an empty directory, so
    // refusing on mere existence would break something that works today.
    const stray = strayPath()
    mkdirSync(stray, { recursive: true })
    const { plan, result } = provision({ setup: ['echo ran > ran.txt'] })
    expect(plan.worktree).toBe(stray)
    expect(result).toEqual({ created: true, setupRan: true })
    expect(existsSync(join(stray, 'ran.txt'))).toBe(true)
  })
})

describe('setupExisting', () => {
  // A worktree that exists is not the same as a worktree that was provisioned:
  // this is how `up --setup` says "run them here anyway".
  const setup = { setup: ['echo ran >> ran.txt'] }

  test('runs setup in a worktree that already existed, without claiming it created it', () => {
    const first = provision(setup)
    logged = []
    const second = provision(setup, { setupExisting: true })
    expect(second.result).toEqual({ created: false, setupRan: true })
    expect(readFileSync(join(first.plan.worktree, 'ran.txt'), 'utf8').trim().split('\n')).toEqual([
      'ran',
      'ran',
    ])
    expect(logged).toContain('setup: echo ran >> ran.txt')
    expect(logged.join('\n')).not.toContain('setup commands skipped')
  })

  test('changes nothing on a fresh worktree', () => {
    const { plan, result } = provision(setup, { setupExisting: true })
    expect(result).toEqual({ created: true, setupRan: true })
    expect(readFileSync(join(plan.worktree, 'ran.txt'), 'utf8').trim()).toBe('ran')
  })

  test('a repo with no setup configured is a no-op, not an error', () => {
    provision({})
    logged = []
    const { result } = provision({}, { setupExisting: true })
    expect(result).toEqual({ created: false, setupRan: false })
  })

  test('a failing setup command stops the run here too', () => {
    provision({})
    expect(() => provision({ setup: ['exit 3'] }, { setupExisting: true })).toThrow(
      'setup command failed (exit 3): exit 3',
    )
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

  test('a setup command that cannot run at all names the worktree, not an exit status', () => {
    // A bootstrap that leaves a plain file where the worktree should be passes the
    // existsSync check, and bash then has nothing to chdir into: no exit status.
    const script = writeBootstrap('makes-a-file.sh', 'echo not-a-worktree > "$2"')
    expect(() =>
      provision({ bootstrap: [script, '--dir', '{worktree}'], setup: ['true'] }),
    ).toThrow('setup command failed to run in')
  })

  test('a failing setup command stops the run and names the command', () => {
    expect(() => provision({ setup: ['exit 3'] })).toThrow('setup command failed (exit 3): exit 3')
  })

  test('a typo\'d placeholder stops the run before any command has run', () => {
    // The half-provisioned worktree that setup's abort rule exists to prevent is
    // exactly what a lazily expanded list produced: command 1 ran, command 2 threw.
    expect(() => provision({ setup: ['echo first > ran.txt', 'cp {wortkree}/.env .env'] })).toThrow(
      /unknown placeholder \{wortkree\} in setup/,
    )
    expect(existsSync(join(repo.parent, 'my-repo-abc-1', 'ran.txt'))).toBe(false)
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

  test('a failing bootstrap fails the run, naming the script', () => {
    const script = writeBootstrap('boom.sh', 'exit 4')
    expect(() => provision({ bootstrap: [script] })).toThrow(`bootstrap failed (exit 4): ${script}`)
  })

  test('a bootstrap that never started names the file and the reason', () => {
    // The spawn never reached a script, so there is no exit status: reading
    // status first reported "exit undefined" and named nothing.
    const missing = join(repo.parent, 'not-here.sh')
    const failure = expect(() => provision({ bootstrap: [missing] }))
    failure.toThrow(`bootstrap failed to run ${missing}`)
    failure.toThrow('ENOENT')
  })

  test('a bootstrap that lost its exec bit lands in the same message', () => {
    const script = writeBootstrap('not-executable.sh', 'true')
    chmodSync(script, 0o644)
    expect(() => provision({ bootstrap: [script] })).toThrow(`bootstrap failed to run ${script}`)
  })

  test('argv[0] may name a script through {config_dir}', () => {
    // The point of the placeholder: the script lives next to the config, and no
    // config has to spell out where Herdr keeps that.
    mkdirSync(join(repo.parent, 'config', 'bootstraps'), { recursive: true })
    const script = writeBootstrap(
      'config/bootstraps/up.sh',
      'git worktree add "$2" -b "$3" --no-track master',
    )
    const { plan, result } = provision({
      bootstrap: ['{config_dir}/bootstraps/up.sh', '--dir', '{worktree}', '{branch}'],
    })
    expect(existsSync(plan.worktree)).toBe(true)
    expect(result.created).toBe(true)
    expect(logged[0]).toContain(`bootstrap: ${script} --dir ${plan.worktree} ABC-1/fix`)
  })

  test('the bootstrap runs first, then setup when --setup asks for it', () => {
    // A bootstrap always runs, and it owns creation, so it has to tolerate being
    // handed a worktree that is already there - like the real ones do.
    const script = writeBootstrap(
      'bootstrap.sh',
      '[ -d "$2" ] || git worktree add "$2" -b "$3" --no-track master\necho bootstrap >> "$2/order.txt"',
    )
    const config = {
      bootstrap: [script, '--dir', '{worktree}', '{branch}'],
      setup: ['echo setup >> order.txt'],
    }
    const first = provision(config)
    expect(first.result).toEqual({ created: true, setupRan: true })

    const second = provision(config, { setupExisting: true })
    expect(second.result).toEqual({ created: false, setupRan: true })
    expect(readFileSync(join(second.plan.worktree, 'order.txt'), 'utf8').trim().split('\n')).toEqual([
      'bootstrap',
      'setup',
      'bootstrap',
      'setup',
    ])
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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Environment } from '../herdr/context.ts'
import type { EngineDeps } from '../deps.ts'
import { createFakeHerdr, type FakeHerdr, type FakeResponses } from '../testing/fakeHerdr.ts'
import { expectRejection } from '../testing/expectRejection.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'
import { up } from './up.ts'

// Drives `up` end to end with no Herdr session and no HERDR_ENV of its own: the
// invoker is the recording fake and the environment is constructed per test, so
// nothing here touches process.env.

let repo: TempRepo
let configDir: string
let logged: string[]

const RESPONSES: FakeResponses = {
  'worktree list': { source: { source_workspace_id: 'wA' } },
  'tab create': { tab: { tab_id: 'wA:t3' }, root_pane: { pane_id: 'wA:p5' } },
  'pane split': [{ pane: { pane_id: 'wA:p6' } }, { pane: { pane_id: 'wA:p7' } }],
  'pane rename': {},
  'pane run': {},
  'pane send-text': {},
  'agent wait': {},
  'agent get': { agent: { state_change_seq: 1 } },
  'agent prompt': {},
  'workspace report-metadata': {},
}

// Inside Herdr, pointed at this test's config dir. Anything else a test needs
// (a plugin context, a clicked url) is another key in the same object.
const env = (overrides: Environment = {}): Environment => ({
  HERDR_ENV: '1',
  HERDR_PLUGIN_CONFIG_DIR: configDir,
  ...overrides,
})

const deps = (fake: FakeHerdr, overrides: Environment = {}): EngineDeps => ({
  invoke: fake.invoke,
  env: env(overrides),
  sleep: async () => {},
  now: () => 1234,
  log: (message) => logged.push(message),
  warn: (message) => logged.push(message),
})

beforeEach(() => {
  repo = createTempRepo('my-repo')
  configDir = join(repo.parent, 'config')
  mkdirSync(configDir, { recursive: true })
  logged = []
})

afterEach(() => {
  repo.cleanup()
})

const writeLocalConfig = (toml: string) => writeFileSync(join(repo.root, '.treehouse.toml'), toml)

describe('up end to end', () => {
  test('provisions the worktree and choreographs the tab in one sequence', async () => {
    writeLocalConfig(`
base = "master"
setup = ["echo ran > ran.txt"]
agent = "claude --resume"

[[panes]]
split = "right"
ratio = 0.5
label = "shell"

[[panes]]
split = "down"
ratio = 0.3
label = "dev"
command = "npm run dev --prefix {worktree}"
autostart = false
`)
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix-thing', '--prompt', 'solve ABC-1'], deps(fake))

    const worktree = join(repo.parent, 'my-repo-abc-1')
    expect(existsSync(worktree)).toBe(true)
    expect(existsSync(join(worktree, 'ran.txt'))).toBe(true)

    expect(fake.commands()).toEqual([
      `worktree list --cwd ${repo.root}`,
      'workspace report-metadata wA --source treehouse --token worktrees=1 --seq 1234 --ttl-ms 86400000',
      `tab create --workspace wA --cwd ${worktree} --label 🌳 abc-1 --no-focus`,
      `pane split wA:p5 --direction right --ratio 0.5 --cwd ${worktree} --no-focus`,
      'pane rename wA:p6 shell',
      `pane split wA:p6 --direction down --ratio 0.3 --cwd ${worktree} --no-focus`,
      'pane rename wA:p7 dev',
      `pane send-text wA:p7 npm run dev --prefix ${worktree}`,
      'pane run wA:p5 claude --resume',
      'agent wait wA:p5 --until idle --timeout 60000',
      'agent get wA:p5',
      'agent prompt wA:p5 solve ABC-1 --wait --until working --timeout 10000',
    ])
    expect(logged).toContain(`worktree:  ${worktree}`)
    expect(logged).toContain('tab:       wA:t3 (🌳 abc-1) in workspace wA')
    expect(logged).toContain(`pane:      wA:p7 (dev): "npm run dev --prefix ${worktree}" prefilled (press Enter to start)`)
    expect(logged).toContain('agent:     claude --resume in wA:p5')
  })

  test('--no-dev skips the panes and --no-agent skips the agent', async () => {
    writeLocalConfig(`
base = "master"
[[panes]]
split = "down"
command = "npm run dev"
`)
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-dev', '--no-agent'], deps(fake))
    expect(fake.callsMatching('pane split')).toHaveLength(0)
    expect(fake.callsMatching('pane run')).toHaveLength(0)
  })

  test('--label and --focus reach the tab', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--label', 'my tab', '--focus', '--no-agent'], deps(fake))
    expect(fake.commands().find((command) => command.startsWith('tab create'))).toContain('--label my tab --focus')
  })

  test('a repo with no workspace open gets one created', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr({
      ...RESPONSES,
      'worktree list': {},
      'workspace create': { workspace: { workspace_id: 'wNew' } },
    })
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(fake))
    expect(fake.commands()[1]).toBe(`workspace create --cwd ${repo.root} --no-focus`)
    expect(fake.commands().find((command) => command.startsWith('tab create'))).toContain('--workspace wNew')
  })

  test('re-running on an existing worktree skips setup and still opens a tab', async () => {
    writeLocalConfig('base = "master"\nsetup = ["echo ran >> ran.txt"]\n')
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(createFakeHerdr(RESPONSES)))
    logged = []
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(fake))
    expect(logged).toContain('worktree already existed; setup commands skipped (re-run with --setup to run them here)')
    expect(fake.callsMatching('tab create')).toHaveLength(1)
  })

  test('a worktree at a path the convention would never derive is reused, not recreated', async () => {
    // The real case: a worktree made by another tool, named after a ticket that
    // is not in the branch name. Deriving the path from worktree_dir sent
    // provisioning off to create a second worktree for a branch git already had
    // checked out, and git refused with "already used by worktree at ...".
    writeLocalConfig('base = "master"\nsetup = ["echo ran > ran.txt"]\n')
    const elsewhere = join(repo.parent, 'npm-packages-abc-11206')
    repo.git('worktree', 'add', elsewhere, '-b', 'ui/upgrade-to-ui-in-konto', '--no-track', 'master')

    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ui/upgrade-to-ui-in-konto', '--no-agent'], deps(fake))

    expect(logged).toContain(`worktree already exists: ${elsewhere}`)
    expect(logged).toContain(`worktree:  ${elsewhere}`)
    expect(fake.commands().find((command) => command.startsWith('tab create'))).toContain(`--cwd ${elsewhere}`)
    expect(existsSync(join(repo.parent, 'my-repo-ui-upgrade-to-ui-in-konto'))).toBe(false)
  })

  test('a branch checked out in the main checkout is refused instead of opening a tab on it', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'master', '--no-agent'], deps(fake)),
      /master is checked out in the main checkout \(.*\), not in a worktree/,
    )
    expect(fake.callsMatching('tab create')).toHaveLength(0)
  })

  test('--setup runs the setup commands in a worktree that already exists', async () => {
    writeLocalConfig('base = "master"\nsetup = ["echo ran >> ran.txt"]\n')
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(createFakeHerdr(RESPONSES)))
    logged = []
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent', '--setup'], deps(fake))
    expect(logged).toContain('setup: echo ran >> ran.txt')
    expect(logged.join('\n')).not.toContain('setup commands skipped')
    expect(readFileSync(join(repo.parent, 'my-repo-abc-1', 'ran.txt'), 'utf8').trim().split('\n')).toEqual([
      'ran',
      'ran',
    ])
    expect(fake.callsMatching('tab create')).toHaveLength(1)
  })

  test('a failing --setup command stops the run before the tab is created', async () => {
    writeLocalConfig('base = "master"\n')
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(createFakeHerdr(RESPONSES)))
    writeLocalConfig('base = "master"\nsetup = ["exit 7"]\n')
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent', '--setup'], deps(fake)),
      /setup command failed \(exit 7\): exit 7/,
    )
    expect(fake.callsMatching('tab create')).toHaveLength(0)
  })

  test('bare claude is the last resort when nothing configures an agent', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix'], deps(fake))
    expect(fake.commands()).toContain('pane run wA:p5 claude')
  })

  test('--agent overrides the configured agent', async () => {
    writeLocalConfig('base = "master"\nagent = "claude --resume"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--agent', 'codex'], deps(fake))
    expect(fake.commands()).toContain('pane run wA:p5 codex')
  })

  test('a config error stops the run before anything is created', async () => {
    writeLocalConfig('setup = "npm ci"\n')
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix'], deps(fake)),
      /invalid config:.*expected a list of strings/s,
    )
    expect(existsSync(join(repo.parent, 'my-repo-abc-1'))).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  test('an unknown config key warns and the run continues', async () => {
    writeLocalConfig('base = "master"\ndev_command = "npm run dev"\n')
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(createFakeHerdr(RESPONSES)))
    expect(logged.join('\n')).toContain('warning: unknown key "dev_command"')
  })

  test('without a branch it says which flags provide one', async () => {
    writeLocalConfig('base = "master"\n')
    await expectRejection(
      up(['--repo', repo.root], deps(createFakeHerdr(RESPONSES))),
      'up requires --branch (or --interactive / --from-link)',
    )
  })

  test('a plain shell invocation resolves the config dir by asking Herdr', async () => {
    // No HERDR_PLUGIN_CONFIG_DIR: only plugin-invoked processes get that handed
    // to them, so this is the branch every `treehouse up` from a shell runs.
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr({ ...RESPONSES, 'plugin config-dir': configDir })
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], {
      ...deps(fake),
      env: { HERDR_ENV: '1' },
    })
    expect(fake.commands()).toContain('plugin config-dir treehouse')
    expect(existsSync(join(repo.parent, 'my-repo-abc-1'))).toBe(true)
  })

  test('outside a Herdr session it refuses', async () => {
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix'], {
        invoke: createFakeHerdr({}).invoke,
        env: {},
      }),
      'not inside a Herdr session (HERDR_ENV != 1)',
    )
  })
})

describe('two branches under one ticket', () => {
  // Attacking one ticket from several angles: two branches, two worktrees, two
  // tabs, two agents. They derive the same {id} path, and the second one used
  // to land on the first one's worktree without a word.
  const reducer = 'ABC-1/reducer-approach'
  const stateMachine = 'ABC-1/state-machine-approach'
  const short = () => join(repo.parent, 'my-repo-abc-1')
  const longFor = (branch: string) =>
    join(repo.parent, `my-repo-abc-1-${branch.split('/')[1]}`)

  const upFor = async (branch: string, extra: string[] = []) => {
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', branch, '--no-agent', ...extra], deps(fake))
    return fake
  }

  const tabCreate = (fake: FakeHerdr) =>
    fake.commands().find((command) => command.startsWith('tab create')) ?? ''

  test('each branch gets its own worktree and tab, the first keeping the short path', async () => {
    writeLocalConfig('base = "master"\n')
    await upFor(reducer)
    const second = await upFor(stateMachine)

    expect(existsSync(short())).toBe(true)
    expect(existsSync(longFor(stateMachine))).toBe(true)
    // Each worktree stands on its own branch, which is the whole point: two
    // agents committing over each other on one branch is what this prevents.
    expect(repo.git('worktree', 'list')).toContain(`[${reducer}]`)
    expect(repo.git('worktree', 'list')).toContain(`[${stateMachine}]`)
    expect(tabCreate(second)).toContain(`--cwd ${longFor(stateMachine)}`)
    // Two tabs labelled 🌳 abc-1 would be indistinguishable in the sidebar, so
    // the disambiguated worktree is labelled by the name it actually goes by.
    expect(tabCreate(second)).toContain('--label 🌳 abc-1-state-machine-approach')
  })

  test('the short path goes to whichever branch was created first', async () => {
    writeLocalConfig('base = "master"\n')
    await upFor(stateMachine)
    const second = await upFor(reducer)

    expect(existsSync(join(repo.parent, 'my-repo-abc-1'))).toBe(true)
    expect(existsSync(longFor(reducer))).toBe(true)
    expect(tabCreate(second)).toContain(`--cwd ${longFor(reducer)}`)
  })

  test('reopening the second branch returns to its own worktree, under the same name', async () => {
    writeLocalConfig('base = "master"\nsetup = ["echo ran >> ran.txt"]\n')
    await upFor(reducer)
    await upFor(stateMachine)
    logged = []
    const again = await upFor(stateMachine)

    expect(logged).toContain(`worktree already exists: ${longFor(stateMachine)}`)
    expect(tabCreate(again)).toContain(`--cwd ${longFor(stateMachine)}`)
    expect(tabCreate(again)).toContain('--label 🌳 abc-1-state-machine-approach')
    // Nothing new was created for the reopen, and setup did not run again.
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(3)
    expect(readFileSync(join(longFor(stateMachine), 'ran.txt'), 'utf8').trim().split('\n')).toEqual(['ran'])
  })

  test('one branch per ticket still lands on the short path it always had', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = await upFor(reducer)
    expect(existsSync(short())).toBe(true)
    expect(tabCreate(fake)).toContain(`--cwd ${short()}`)
    expect(tabCreate(fake)).toContain('--label 🌳 abc-1')
    expect(existsSync(longFor(reducer))).toBe(false)
  })

  test('a worktree_dir with no room to tell them apart refuses instead of opening a tab', async () => {
    // Every branch of the ticket derives one path here, so there is no second
    // one to move to; saying so beats reusing the first branch's worktree.
    writeLocalConfig('base = "master"\nworktree_dir = "../{repo}-{ticket}"\n')
    await upFor(reducer)
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', stateMachine, '--no-agent'], deps(fake)),
      /every path worktree_dir derives for ABC-1\/state-machine-approach is already a worktree of another branch: .*my-repo-abc-1 \(ABC-1\/reducer-approach\)/,
    )
    expect(fake.callsMatching('tab create')).toHaveLength(0)
    expect(fake.callsMatching('pane run')).toHaveLength(0)
  })
})

describe('agent context', () => {
  // The context file lives outside every repo, under a name that starts with
  // the repo and the {id}. These tests look it up by that prefix rather than
  // spelling the whole name, so the naming rule stays the engine's business.
  const contextDir = join(tmpdir(), 'treehouse-context')
  const contextFiles = (prefix: string) =>
    existsSync(contextDir)
      ? readdirSync(contextDir).filter((name) => name.startsWith(`my-repo-${prefix}`))
      : []
  const contextFile = (id: string) => {
    const found = contextFiles(`${id}-`)
    expect(found).toHaveLength(1)
    return join(contextDir, found[0])
  }

  const APPEND = 'agent = \'claude --append-system-prompt "$(cat {context_file})"\''

  afterEach(() => {
    for (const name of contextFiles('')) rmSync(join(contextDir, name), { force: true })
  })

  test('the agent command carries the file, and the file the expanded text', async () => {
    writeLocalConfig(`
base = "master"
${APPEND}
context = """
You are in a worktree of {repo}: {worktree}, branch {branch}, ticket {ticket}.
Bootstrapped targets: {targets}.
Do not start the dev command.
"""
`)
    const fake = createFakeHerdr(RESPONSES)
    await up(
      ['--repo', repo.root, '--branch', 'ABC-1/fix-thing', '--target', 'services/a', '--target', 'packages/b'],
      deps(fake),
    )

    const worktree = join(repo.parent, 'my-repo-abc-1')
    expect(fake.commands()).toContain(
      `pane run wA:p5 claude --append-system-prompt "$(cat ${contextFile('abc-1')})"`,
    )
    expect(readFileSync(contextFile('abc-1'), 'utf8')).toBe(
      `You are in a worktree of my-repo: ${worktree}, branch ABC-1/fix-thing, ticket abc-1.\n` +
        'Bootstrapped targets: services/a, packages/b.\n' +
        'Do not start the dev command.\n',
    )
  })

  test('re-running up overwrites the file instead of accumulating', async () => {
    writeLocalConfig(`base = "master"\n${APPEND}\ncontext = "first"\n`)
    await up(['--repo', repo.root, '--branch', 'ABC-77/fix'], deps(createFakeHerdr(RESPONSES)))
    writeLocalConfig(`base = "master"\n${APPEND}\ncontext = "second"\n`)
    await up(['--repo', repo.root, '--branch', 'ABC-77/fix'], deps(createFakeHerdr(RESPONSES)))

    expect(contextFiles('abc-77')).toHaveLength(1)
    expect(readFileSync(contextFile('abc-77'), 'utf8')).toBe('second\n')
  })

  test('--agent is expanded like a configured one', async () => {
    writeLocalConfig('base = "master"\ncontext = "standing instructions"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(
      ['--repo', repo.root, '--branch', 'ABC-1/fix', '--agent', 'codex --cwd {worktree} --context {context_file}'],
      deps(fake),
    )
    expect(fake.commands()).toContain(
      `pane run wA:p5 codex --cwd ${join(repo.parent, 'my-repo-abc-1')} --context ${contextFile('abc-1')}`,
    )
  })

  test('context the agent command never reads is refused, not silently dropped', async () => {
    writeLocalConfig('base = "master"\nagent = "claude --resume"\ncontext = "standing instructions"\n')
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix'], deps(fake)),
      /context is configured for my-repo but the agent command has no \{context_file\}/,
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('{context_file} with no context to put in it is refused', async () => {
    writeLocalConfig(`base = "master"\n${APPEND}\n`)
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix'], deps(fake)),
      /uses \{context_file\} but the context is empty/,
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('--no-agent needs neither and writes no file', async () => {
    writeLocalConfig('base = "master"\nagent = "claude --resume"\ncontext = "standing instructions"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-88/fix', '--no-agent'], deps(fake))
    expect(fake.callsMatching('pane run')).toHaveLength(0)
    expect(contextFiles('abc-88')).toEqual([])
  })

  test('a placeholder typo in the context fails before the worktree is provisioned', async () => {
    writeLocalConfig(`base = "master"\n${APPEND}\ncontext = "branch {brnach}"\n`)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix'], deps(createFakeHerdr(RESPONSES))),
      'unknown placeholder {brnach} in context',
    )
    expect(existsSync(join(repo.parent, 'my-repo-abc-1'))).toBe(false)
  })

  test('a placeholder typo in the agent command fails before the worktree is provisioned', async () => {
    writeLocalConfig('base = "master"\nagent = "claude --cwd {wortkree}"\n')
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix'], deps(createFakeHerdr(RESPONSES))),
      'unknown placeholder {wortkree} in the agent command',
    )
    expect(existsSync(join(repo.parent, 'my-repo-abc-1'))).toBe(false)
  })

  test('a repo with no context is untouched', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-99/fix'], deps(fake))
    expect(fake.commands()).toContain('pane run wA:p5 claude')
    expect(contextFiles('abc-99')).toEqual([])
  })

  test('both halves in [defaults] reach a repo that only overrides the text', async () => {
    // The arrangement that works cleanly when several repos are configured:
    // [defaults] owns the agent line (permission posture included) and a context
    // that is true everywhere, and a repo replaces only the text.
    writeFileSync(
      join(configDir, 'config.toml'),
      `[defaults]\n${APPEND}\ncontext = "generic, from defaults"\n\n` +
        `[repos.my-repo]\nroot = ${JSON.stringify(repo.root)}\nbase = "master"\ncontext = "specific, from the repo block"\n`,
    )
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-2/fix'], deps(fake))

    expect(fake.commands()).toContain(
      `pane run wA:p5 claude --append-system-prompt "$(cat ${contextFile('abc-2')})"`,
    )
    expect(readFileSync(contextFile('abc-2'), 'utf8')).toBe('specific, from the repo block\n')
  })

  test('a context that expands to nothing is refused, not written as an empty file', async () => {
    // Configured and still nothing to deliver: {ticket} is empty on a branch
    // without one, and an empty --append-system-prompt is the state the other
    // refusal exists to prevent, reached from the other side.
    writeLocalConfig(`base = "master"\n${APPEND}\ncontext = "{ticket}"\n`)
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'fix/no-ticket-here'], deps(fake)),
      /uses \{context_file\} but the context is empty/,
    )
    expect(fake.calls).toHaveLength(0)
    expect(contextFiles('fix-no-ticket')).toEqual([])
  })

  test('a typo in the agent command leaves no context file behind', async () => {
    writeLocalConfig(
      `base = "master"\ncontext = "standing instructions"\n` +
        `agent = 'claude --cwd {wortkree} --append-system-prompt "$(cat {context_file})"'\n`,
    )
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-3/fix'], deps(createFakeHerdr(RESPONSES))),
      'unknown placeholder {wortkree} in the agent command',
    )
    expect(contextFiles('abc-3')).toEqual([])
  })

  test('--model lands in the slot, alongside the context the repo already had', async () => {
    writeLocalConfig(
      `base = "master"\ncontext = "standing instructions"\nmodel_arg = '--model {model}'\n` +
        `agent = 'claude --dangerously-skip-permissions {model_arg} --append-system-prompt "$(cat {context_file})"'\n`,
    )
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-5/fix', '--model', 'fable'], deps(fake))
    expect(fake.commands()).toContain(
      'pane run wA:p5 claude --dangerously-skip-permissions --model fable ' +
        `--append-system-prompt "$(cat ${contextFile('abc-5')})"`,
    )
  })

  test('without --model the slot disappears and the command is what it always was', async () => {
    writeLocalConfig(
      `base = "master"\nmodel_arg = '--model {model}'\nagent = 'claude --resume {model_arg}'\n`,
    )
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-6/fix'], deps(fake))
    expect(fake.commands()).toContain('pane run wA:p5 claude --resume')
  })

  test('--model with no model_arg configured is refused', async () => {
    writeLocalConfig('base = "master"\nagent = "claude --resume"\n')
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-7/fix', '--model', 'fable'], deps(fake)),
      /--model fable was asked for, but my-repo has no model_arg to put it in/,
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('--model with a slotless agent command is refused before the worktree exists', async () => {
    // The failure worth catching: the tab opens, the agent runs, and only the
    // model is missing, which nothing about the tab would show you. Setup here
    // is what must not have run by the time the refusal lands.
    writeLocalConfig(
      `base = "master"\nsetup = ["touch setup-ran"]\n` +
        `model_arg = '--model {model}'\nagent = "claude --resume"\n`,
    )
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-8/fix', '--model', 'fable'], deps(fake)),
      /the agent command for my-repo has no \{model_arg\}, so the model would be dropped/,
    )
    expect(existsSync(join(repo.parent, 'my-repo-abc-8'))).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  test('a $-prefixed brace is not a slot, so the model is refused rather than dropped', async () => {
    // ${model_arg} is a shell variable the agent's shell expands to nothing.
    // Reading it as a slot let the refusal miss and the model vanish.
    writeLocalConfig(
      `base = "master"\nmodel_arg = '--model {model}'\nagent = 'claude \${model_arg}'\n`,
    )
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-12/fix', '--model', 'fable'], deps(fake)),
      /has no \{model_arg\}, so the model would be dropped/,
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('$-prefixed braces in setup and pane commands still pass through', async () => {
    // The names that collide with the scope-restricted placeholders are exactly
    // the ones a substring guard broke; ${HOST} never could.
    writeLocalConfig(
      `base = "master"\nsetup = ["echo \${model} \${model_arg} \${context_file}"]\n`,
    )
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-13/fix'], deps(fake))
    expect(fake.commands()).toContain('pane run wA:p5 claude')
  })

  test('--model fills the slot of an ad-hoc --agent too', async () => {
    // The pair --model exists to make unnecessary, so it had better compose:
    // model_arg comes from the config, the command from the flag.
    writeLocalConfig(`base = "master"\nmodel_arg = '--model {model}'\n`)
    const fake = createFakeHerdr(RESPONSES)
    await up(
      ['--repo', repo.root, '--branch', 'ABC-14/fix', '--agent', 'codex {model_arg} exec', '--model', 'opus'],
      deps(fake),
    )
    expect(fake.commands()).toContain('pane run wA:p5 codex --model opus exec')
  })

  test('a model refusal leaves no context file behind', async () => {
    writeLocalConfig(`base = "master"\n${APPEND}\ncontext = "standing instructions"\n`)
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-15/fix', '--model', 'fable'], deps(fake)),
      /has no model_arg to put it in/,
    )
    expect(contextFiles('abc-15')).toEqual([])
  })

  test('a model_arg nothing asks for is left alone', async () => {
    // Unlike a context nothing reads: no model was requested, so nothing is lost.
    writeLocalConfig(`base = "master"\nmodel_arg = '--model {model}'\nagent = "claude --resume"\n`)
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-9/fix'], deps(fake))
    expect(fake.commands()).toContain('pane run wA:p5 claude --resume')
  })

  test('--model and --no-agent together are refused', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-10/fix', '--no-agent', '--model', 'fable'], deps(fake)),
      /--model needs an agent to apply to/,
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('model_arg in [defaults] reaches a repo that overrides nothing', async () => {
    writeFileSync(
      join(configDir, 'config.toml'),
      `[defaults]\nmodel_arg = '--model {model}'\nagent = 'claude {model_arg}'\n\n` +
        `[repos.my-repo]\nroot = ${JSON.stringify(repo.root)}\nbase = "master"\n`,
    )
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-11/fix', '--model', 'opus'], deps(fake))
    expect(fake.commands()).toContain('pane run wA:p5 claude --model opus')
  })

  test('braces that are not placeholders still pass through the agent command', async () => {
    // The agent command is expanded now, which it was not before, so the same
    // shell-braces guarantee the other expansions have applies here too.
    writeLocalConfig('base = "master"\nagent = "docker exec ${HOST} claude --fmt \'{{.Names}}\'"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-4/fix'], deps(fake))
    expect(fake.commands()).toContain("pane run wA:p5 docker exec ${HOST} claude --fmt '{{.Names}}'")
  })
})

describe('invocation context', () => {
  const context = (fields: Record<string, unknown>): Environment => ({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(fields),
  })

  test('a plugin invocation with no cwd in the context refuses instead of targeting the plugin repo', async () => {
    await expectRejection(
      up(['--branch', 'ABC-1/fix'], deps(createFakeHerdr({}), context({ invocation_source: 'keybinding' }))),
      'refusing to fall back to the plugin repo',
    )
  })

  test('the focused pane cwd from the context is used as the repo', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--branch', 'ABC-1/fix', '--no-agent'], deps(fake, context({ focused_pane_cwd: repo.root })))
    expect(fake.commands()[0]).toBe(`worktree list --cwd ${repo.root}`)
  })

  test('a clicked Jira link becomes a wip branch in the clicked pane\'s repo', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--from-link', '--no-agent'], deps(fake, {
      ...context({ focused_pane_cwd: repo.root }),
      HERDR_PLUGIN_CLICKED_URL: 'https://example.atlassian.net/browse/ABC-42',
    }))
    expect(existsSync(join(repo.parent, 'my-repo-abc-42'))).toBe(true)
    expect(repo.git('branch', '--list', 'ABC-42/wip')).toContain('ABC-42/wip')
    // A click carries no judgment, so the tab is focused but no prompt is sent.
    expect(fake.commands().find((command) => command.startsWith('tab create'))).toContain('--focus')
  })

  test('a link with no derivable ticket refuses', async () => {
    await expectRejection(
      up(['--from-link'], deps(createFakeHerdr({}), { HERDR_PLUGIN_CLICKED_URL: 'https://example.com/nope' })),
      'could not derive a branch from clicked url',
    )
  })
})

describe('interactive popup', () => {
  // Scripted answers in, recorded questions out: the same leverage the fake
  // Herdr gives the tab choreography.
  const interactiveDeps = (fake: FakeHerdr, answers: string[], asked: string[]): EngineDeps => ({
    ...deps(fake),
    ask: async (question) => {
      asked.push(question)
      return answers.shift() ?? ''
    },
  })

  test('asks for a branch, focuses the tab, and sends the copy through the log seam', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    const asked: string[] = []
    await up(['--repo', repo.root, '--interactive', '--no-agent'], interactiveDeps(fake, [' ABC-9/fix-popup '], asked))

    // No bootstrap takes targets here, so the branch question is the only one.
    expect(asked).toEqual(['Branch name (e.g. ABC-1234/fix-thing): '])
    expect(logged).toContain('New worktree tab in my-repo\n')
    expect(existsSync(join(repo.parent, 'my-repo-abc-9'))).toBe(true)
    // An interactive answer means "take me there", like a clicked link.
    expect(fake.commands().find((command) => command.startsWith('tab create'))).toContain('--focus')
  })

  // A bootstrap that creates the worktree and records the targets it was
  // handed, so the tests can assert what actually reached it.
  const writeTargetsBootstrap = () => {
    const script = join(repo.parent, 'bootstrap.sh')
    writeFileSync(
      script,
      '#!/usr/bin/env bash\nset -e\nroot="$1"; worktree="$2"; branch="$3"; shift 3\n' +
        'git -C "$root" worktree add "$worktree" -b "$branch" --no-track master --quiet\n' +
        'echo "$@" > "$worktree/targets.txt"\n',
      { mode: 0o755 },
    )
    writeLocalConfig(`bootstrap = ["${script}", "{root}", "{worktree}", "{branch}", "{targets...}"]\n`)
  }

  test('asks for targets when the bootstrap takes them, comma-splitting the answer', async () => {
    writeTargetsBootstrap()
    const fake = createFakeHerdr(RESPONSES)
    const asked: string[] = []
    await up(
      ['--repo', repo.root, '--interactive', '--no-agent'],
      interactiveDeps(fake, ['ABC-9/fix', ' services/a, packages/b '], asked),
    )

    expect(asked[1]).toBe('Targets (comma-separated): ')
    expect(logged.join('\n')).toContain('Targets: repo-relative dirs the bootstrap should install dependencies')
    const targets = await Bun.file(join(repo.parent, 'my-repo-abc-9', 'targets.txt')).text()
    expect(targets.trim()).toBe('services/a packages/b')
  })

  test('an empty targets answer passes no targets to the bootstrap', async () => {
    writeTargetsBootstrap()
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--interactive', '--no-agent'], interactiveDeps(fake, ['ABC-9/fix', '  '], []))

    const targets = await Bun.file(join(repo.parent, 'my-repo-abc-9', 'targets.txt')).text()
    expect(targets.trim()).toBe('')
  })
})

describe('review fixes', () => {
  test('--prompt with --no-agent is refused rather than silently dropped', async () => {
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent', '--prompt', 'do it'], deps(fake)),
      '--prompt needs an agent to hand the task to',
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('a placeholder typo in a pane command fails before the worktree is created', async () => {
    writeLocalConfig(`
base = "master"
setup = ["echo ran > ran.txt"]

[[panes]]
split = "down"
command = "npm run dev --prefix {wortkree}"
`)
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(fake)),
      'unknown placeholder {wortkree}',
    )
    expect(existsSync(join(repo.parent, 'my-repo-abc-1'))).toBe(false)
  })

  test('a broken block for another repo does not stop this one', async () => {
    writeFileSync(
      join(configDir, 'config.toml'),
      `[repos.somewhere-else]\nroot = "/nowhere/at/all"\nsetup = "npm ci"\n`,
    )
    writeLocalConfig('base = "master"\n')
    const fake = createFakeHerdr(RESPONSES)
    await up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(fake))
    expect(logged.join('\n')).toContain("another repo's block, ignored here")
    expect(existsSync(join(repo.parent, 'my-repo-abc-1'))).toBe(true)
  })

  test('a block keyed like this repo cannot slip through by breaking its own root', async () => {
    // `root` is the match key, so a block that broke it matches nothing and
    // would demote its own errors to "another repo's block"; the directory-name
    // fallback keeps them fatal here instead of running unconfigured.
    writeFileSync(join(configDir, 'config.toml'), `[repos.my-repo]\nsetup = "npm ci"\n`)
    const fake = createFakeHerdr(RESPONSES)
    await expectRejection(
      up(['--repo', repo.root, '--branch', 'ABC-1/fix', '--no-agent'], deps(fake)),
      /invalid config:.*missing required key "root"/s,
    )
    expect(existsSync(join(repo.parent, 'my-repo-abc-1'))).toBe(false)
  })
})

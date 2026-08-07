import type { ProcessRun, ProcessRunner } from '../processRunner.ts'

// Recording fake for the process seam: records command, args and cwd of every
// run in order and answers a scripted outcome, so a test can assert what
// provisioning would have run without a worktree changing under it.
//
// Outcomes are keyed by the leading words of the command line ("bash -lc npm
// ci", a script path); the longest matching key wins. A value can be:
//   - an exit status
//   - { error } for a spawn that never started (argv[0] missing, no exec bit)
//   - a function of the run, for an outcome that depends on it and for the side
//     effects a real script would have (a bootstrap creating the worktree)
// An unmatched run exits 0. Unlike the Herdr fake, an unscripted call is not a
// test passing by accident: the assertions here are on what was run, not on
// what came back.
//
// What it cannot prove, and what provision.test.ts therefore keeps real spawns
// for: a relative argv[0] resolved against cwd, a script without its exec bit,
// and a cwd that is not a directory.
export type FakeOutcome = number | { error: string }
export type FakeOutcomes = Record<string, FakeOutcome | ((run: ProcessRun) => FakeOutcome | void)>

export type FakeProcessRunner = {
  run: ProcessRunner
  runs: ProcessRun[]
  commands: () => string[]
  runsIn: (cwd: string) => ProcessRun[]
}

const commandLine = (run: ProcessRun) => [run.command, ...run.args].join(' ')

const matchKey = (line: string, keys: string[]): string | undefined =>
  keys
    .filter((key) => line === key || line.startsWith(`${key} `))
    .sort((a, b) => b.length - a.length)[0]

export const createFakeProcessRunner = (outcomes: FakeOutcomes = {}): FakeProcessRunner => {
  const runs: ProcessRun[] = []
  const keys = Object.keys(outcomes)

  const run: ProcessRunner = (request) => {
    // spawnSync throws a TypeError on an empty or missing argv[0] rather than
    // running anything, so answering exit 0 would let the fake pass exactly the
    // regression (`bootstrap = []`) the length guard in provision.ts exists for.
    if (!request.command) {
      throw new Error(`fake process runner: no command to run (args: ${request.args.join(' ')})`)
    }
    runs.push({ ...request, args: [...request.args] })
    const key = matchKey(commandLine(request), keys)
    const scripted = key === undefined ? 0 : outcomes[key]
    const outcome = typeof scripted === 'function' ? (scripted(request) ?? 0) : scripted
    if (typeof outcome === 'number') return { status: outcome }
    return { status: null, error: new Error(outcome.error) }
  }

  return {
    run,
    runs,
    commands: () => runs.map(commandLine),
    runsIn: (cwd) => runs.filter((recorded) => recorded.cwd === cwd),
  }
}

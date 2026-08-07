import { spawnSync } from 'node:child_process'

// Running an external process is a dependency, the way the Herdr invoker is:
// `spawnProcess` is the production adapter and src/testing/fakeProcessRunner.ts
// the recording one. Reasoning, git.ts's exemption included:
// docs/worktree-lifecycle.md.

export type ProcessRun = {
  command: string
  args: string[]
  cwd: string
}

// The fields of spawnSync's result a caller reads. A spawn that never started
// (argv[0] missing or without its exec bit, a cwd that is not a directory) has
// no exit status and puts the reason in `error` instead, which is why every
// caller checks `error` before the status.
export type ProcessResult = {
  status: number | null
  error?: Error
}

export type ProcessRunner = (run: ProcessRun) => ProcessResult

// stdio: 'inherit' - a bootstrap script and a setup command talk to the user's
// terminal, so nothing here captures their output. `status ?? null` because a
// spawn that never started leaves it undefined on Bun and null on Node, and a
// seam whose two adapters disagree on the spelling of "no status" is a fake that
// lies: the type says null, so the adapter answers null.
export const spawnProcess: ProcessRunner = ({ command, args, cwd }) => {
  const { status, error } = spawnSync(command, args, { cwd, stdio: 'inherit' })
  return { status: status ?? null, error }
}

import { spawnSync } from 'node:child_process'

// Running an external process is a dependency, the way the Herdr invoker is:
// `spawnProcess` is the production adapter and src/testing/fakeProcessRunner.ts
// the recording one. Deliberately not a leaf git.ts uses: git's own behaviour is
// exactly what git.test.ts pins, so that module keeps spawning git itself.

export type ProcessRun = {
  command: string
  args: string[]
  cwd: string
}

// The fields of spawnSync's result a caller reads. A spawn that never started
// (argv[0] missing or without its exec bit, a cwd that is not a directory)
// leaves status null and the reason in `error`, which is why every caller checks
// `error` before the status.
export type ProcessResult = {
  status: number | null
  error?: Error
}

export type ProcessRunner = (run: ProcessRun) => ProcessResult

// stdio: 'inherit' - a bootstrap script and a setup command talk to the user's
// terminal, so nothing here captures their output.
export const spawnProcess: ProcessRunner = ({ command, args, cwd }) => {
  const { status, error } = spawnSync(command, args, { cwd, stdio: 'inherit' })
  return { status, error }
}

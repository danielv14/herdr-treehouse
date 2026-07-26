import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A throwaway git repo with one commit on master, for tests that need real git
// worktree mechanics. Worktrees land as siblings inside `parent`, so removing it
// cleans up everything.
export type TempRepo = {
  parent: string
  root: string
  name: string
  git: (...args: string[]) => string
  cleanup: () => void
}

export const createTempRepo = (name = 'repo'): TempRepo => {
  // realpath: on macOS /var is a symlink to /private/var, and git reports the
  // resolved path, so tests would otherwise compare two spellings of one dir.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'treehouse-test-')))
  const root = join(parent, name)
  const run = (cwd: string, args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`)
    }
    return result.stdout.trim()
  }

  mkdirSync(root, { recursive: true })
  run(root, ['init', '--initial-branch=master'])
  run(root, ['config', 'user.email', 'test@example.com'])
  run(root, ['config', 'user.name', 'treehouse test'])
  writeFileSync(join(root, 'README.md'), '')
  run(root, ['add', '.'])
  run(root, ['commit', '-m', 'initial'])

  return {
    parent,
    root,
    name,
    git: (...args) => run(root, args),
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  }
}

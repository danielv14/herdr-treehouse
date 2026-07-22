import { resolve, sep } from 'node:path'
import { dirtyFiles, findMainRepoRoot, findRepoRoot, git, isLinkedWorktree } from './git.ts'
import { herdr, insideHerdr } from './herdr.ts'

type DownOptions = {
  path?: string
}

const parseDownArgs = (argv: string[]): DownOptions => {
  const options: DownOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--path') {
      index += 1
      options.path = argv[index]
      if (!options.path) throw new Error('--path requires a value')
    } else throw new Error(`unknown option for down: ${arg}`)
  }
  return options
}

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', '-zsh', '-bash'])

type PaneRecord = { pane_id: string; tab_id: string; cwd?: string }

const panesInWorktree = (workspaceId: string, worktreePath: string): PaneRecord[] => {
  const listed = herdr(['pane', 'list', '--workspace', workspaceId])
  const panes: PaneRecord[] = listed?.panes ?? []
  const prefix = worktreePath.endsWith(sep) ? worktreePath : worktreePath + sep
  return panes.filter((pane) => pane.cwd === worktreePath || pane.cwd?.startsWith(prefix))
}

const busyProcesses = (paneId: string): string[] => {
  const info = herdr(['pane', 'process-info', '--pane', paneId])
  const processes: Array<{ name?: string; cmdline?: string }> =
    info?.process_info?.foreground_processes ?? []
  return processes
    .filter((process_) => !SHELL_NAMES.has(process_.name ?? ''))
    .map((process_) => process_.cmdline ?? process_.name ?? 'unknown process')
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

// Prompt tooling (starship etc.) spawns short-lived processes on every prompt
// render, so a single busy snapshot gives false positives. Only report panes
// that are still busy on a second look.
const confirmedBusyProcesses = async (paneId: string): Promise<string[]> => {
  if (busyProcesses(paneId).length === 0) return []
  await sleep(750)
  return busyProcesses(paneId)
}

export const down = async (argv: string[]) => {
  const options = parseDownArgs(argv)
  const worktreePath = resolve(options.path ?? process.cwd())

  if (!isLinkedWorktree(worktreePath)) {
    throw new Error(`${worktreePath} is not a linked worktree (refusing to touch a main checkout)`)
  }
  const worktreeRoot = findRepoRoot(worktreePath)
  const mainRepoRoot = findMainRepoRoot(worktreePath)

  const dirty = dirtyFiles(worktreeRoot)
  if (dirty.length > 0) {
    throw new Error(
      `worktree has uncommitted changes, refusing to remove:\n${dirty.join('\n')}\n` +
        'Commit, stash, or clean up first (workon never uses --force).',
    )
  }

  // Closing the tab kills its PTYs, so anything still running (dev servers,
  // agents) blocks teardown; the user shuts those down manually by design.
  let tabIds: string[] = []
  if (insideHerdr()) {
    try {
      const listed = herdr(['worktree', 'list', '--cwd', mainRepoRoot])
      const workspaceId = listed?.source?.source_workspace_id
      if (workspaceId) {
        const panes = panesInWorktree(workspaceId, worktreeRoot)
        // Skip the caller's own pane: when down runs from inside the worktree
        // tab, the engine itself would otherwise count as a busy process.
        const ownPaneId = process.env.HERDR_PANE_ID
        const candidates = panes.filter((pane) => pane.pane_id !== ownPaneId)
        const busy: string[] = []
        for (const pane of candidates) {
          const commands = await confirmedBusyProcesses(pane.pane_id)
          busy.push(...commands.map((cmd) => `  ${pane.pane_id}: ${cmd}`))
        }
        if (busy.length > 0) {
          throw new Error(
            `panes in the worktree tab still run processes:\n${busy.join('\n')}\n` +
              'Stäng dem manuellt först, kör sedan down igen.',
          )
        }
        tabIds = [...new Set(panes.map((pane) => pane.tab_id))]
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('still run processes')) throw error
      console.error(`warning: could not inspect Herdr panes (${error}), removing worktree only`)
    }
  }

  git(mainRepoRoot, ['worktree', 'remove', worktreeRoot])
  console.log(`removed worktree: ${worktreeRoot}`)
  console.log('branch left in place (cleaned up via PR merge as usual)')

  for (const tabId of tabIds) {
    herdr(['tab', 'close', tabId])
    console.log(`closed tab: ${tabId}`)
  }
}

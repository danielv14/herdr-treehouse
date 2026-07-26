import { resolve } from 'node:path'
import { parseFlags, type CommandSpec } from './cli.ts'
import { callerPaneId, callerTabId, invocationTargetPath } from './context.ts'
import { resolveDeps, type EngineDeps } from './deps.ts'
import { dirtyFiles, findMainRepoRoot, findRepoRoot, git, isLinkedWorktree } from './git.ts'

export const DOWN_COMMAND: CommandSpec = {
  name: 'down',
  usage: ['treehouse down [--path <worktree>]'],
  summary: 'remove the worktree and close its tab',
  notes: ['Refuses on uncommitted changes and on panes with running processes.'],
  flags: [
    { flag: '--path', kind: 'value', key: 'path', placeholder: '<worktree>', help: 'worktree to tear down (default: cwd)' },
    { flag: '--interactive', kind: 'boolean', key: 'interactive', help: 'confirm before removing (used by the keybinding action)' },
  ],
}

const confirmInteractively = async (worktreeRoot: string): Promise<boolean> => {
  const { createInterface } = await import('node:readline/promises')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await readline.question(`Remove worktree ${worktreeRoot} and close its tab? [y/N] `)
  readline.close()
  return answer.trim().toLowerCase() === 'y'
}

export const down = async (argv: string[], deps: EngineDeps) => {
  const { tabs, insideHerdr, log } = resolveDeps(deps)
  const flags = parseFlags(DOWN_COMMAND, argv)
  const worktreePath = resolve(
    invocationTargetPath({ explicit: flags.value('path'), prefer: 'pane' }) ?? process.cwd(),
  )

  if (!isLinkedWorktree(worktreePath)) {
    throw new Error(`${worktreePath} is not a linked worktree (refusing to touch a main checkout)`)
  }
  const worktreeRoot = findRepoRoot(worktreePath)
  const mainRepoRoot = findMainRepoRoot(worktreePath)

  if (flags.flag('interactive') && !(await confirmInteractively(worktreeRoot))) {
    log('Aborted.')
    return
  }

  const dirty = dirtyFiles(worktreeRoot)
  if (dirty.length > 0) {
    throw new Error(
      `worktree has uncommitted changes, refusing to remove:\n${dirty.join('\n')}\n` +
        'Commit, stash, or clean up first (treehouse never uses --force).',
    )
  }

  // Closing the tab kills its PTYs, so anything still running (dev servers,
  // busy agents) blocks teardown; the user shuts those down manually by
  // design. Inspection failures abort rather than degrade: proceeding without
  // the busy check could delete a worktree under a running dev server.
  let tabIds: string[] = []
  if (insideHerdr()) {
    const workspaceId = tabs.findWorkspace(mainRepoRoot)
    if (!workspaceId) {
      log('repo has no open workspace in Herdr; removing the worktree only')
    } else {
      // Skip the caller's own pane: when down runs from inside the worktree
      // tab, the engine itself would otherwise count as a busy process.
      const inspection = await tabs.inspectWorktreeTab(workspaceId, worktreeRoot, {
        ignorePaneId: callerPaneId(),
      })
      if (inspection.busyPanes.length > 0) {
        const listed = inspection.busyPanes.map((pane) => `  ${pane.paneId}: ${pane.command}`)
        throw new Error(
          `panes in the worktree tab still run processes:\n${listed.join('\n')}\n` +
            'Close them manually, then run down again.',
        )
      }
      tabIds = inspection.tabIds
    }
  }

  // The process may be running inside the worktree it is about to delete;
  // spawning anything from a deleted cwd fails with ENOENT. Move out first.
  process.chdir(mainRepoRoot)

  git(mainRepoRoot, ['worktree', 'remove', worktreeRoot])
  log(`removed worktree: ${worktreeRoot}`)
  log('branch left in place (cleaned up via PR merge as usual)')

  const ownTabId = callerTabId()
  if (ownTabId && tabIds.includes(ownTabId)) {
    log('closing this tab last (the teardown ran from inside it)')
  }
  tabs.closeTabs(tabIds, { lastTabId: ownTabId, onClosed: (tabId) => log(`closed tab: ${tabId}`) })
}

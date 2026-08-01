import { relative } from 'node:path'
import { parseFlags, type CommandSpec } from '../cli.ts'
import { resolveAllRepoConfigs } from '../config/config.ts'
import { resolveDeps, type EngineDeps } from '../deps.ts'
import {
  attachTabFacts,
  collectRepoInventory,
  type InventoryWorktree,
  type RepoInventory,
} from '../worktree/inventory.ts'

export const LS_COMMAND: CommandSpec = {
  name: 'ls',
  usage: ['treehouse ls [--repo <name>] [--json]'],
  summary: 'list the worktrees of every configured repo',
  notes: [
    'Repos come from the central config; inside Herdr each row also shows its tab and agent.',
    'Read-only and offline: ahead/behind counts are against the base as last fetched.',
  ],
  flags: [
    { flag: '--repo', kind: 'value', key: 'repo', placeholder: '<name>', help: 'only this repo (config key)' },
    { flag: '--json', kind: 'boolean', key: 'json', help: 'stable JSON output for scripting' },
  ],
}

// The published shape (--json): every field always present, absent facts null.
// `pr` is reserved for the planned GitHub enrichment so adding it later does
// not break consumers.
type JsonWorktree = {
  repo: string
  path: string
  branch: string | null
  ticket: string | null
  id: string | null
  managed: boolean
  missing: boolean
  base: string
  dirtyFiles: number | null
  ahead: number | null
  behind: number | null
  lastCommitAt: string | null
  tab: { tabId: string; agent: string | null; agentStatus: string | null } | null
  pr: null
}

const toJson = (worktree: InventoryWorktree): JsonWorktree => ({
  repo: worktree.repo,
  path: worktree.path,
  branch: worktree.branch ?? null,
  ticket: worktree.ticket === '' ? null : worktree.ticket,
  id: worktree.id === '' ? null : worktree.id,
  managed: worktree.managed,
  missing: worktree.missing,
  base: worktree.base,
  dirtyFiles: worktree.dirtyFiles ?? null,
  ahead: worktree.ahead ?? null,
  behind: worktree.behind ?? null,
  lastCommitAt:
    worktree.lastCommitAt === undefined ? null : new Date(worktree.lastCommitAt * 1000).toISOString(),
  tab: worktree.tab
    ? {
        tabId: worktree.tab.tabId,
        agent: worktree.tab.agent ?? null,
        agentStatus: worktree.tab.agentStatus ?? null,
      }
    : null,
  pr: null,
})

const age = (unixSeconds: number | undefined, nowMs: number): string => {
  if (unixSeconds === undefined) return '-'
  const minutes = Math.floor((nowMs / 1000 - unixSeconds) / 60)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / (60 * 24))}d ago`
}

const dirtyCell = (worktree: InventoryWorktree): string => {
  if (worktree.missing) return 'missing'
  if (worktree.dirtyFiles === undefined) return '-'
  return worktree.dirtyFiles === 0 ? 'clean' : `${worktree.dirtyFiles} dirty`
}

const baseCell = (worktree: InventoryWorktree): string =>
  worktree.ahead === undefined || worktree.behind === undefined
    ? '-'
    : `+${worktree.ahead}/-${worktree.behind}`

const tabCell = (worktree: InventoryWorktree): string => {
  if (!worktree.tab) return '-'
  if (!worktree.tab.agent) return 'open'
  return `${worktree.tab.agent} (${worktree.tab.agentStatus ?? 'unknown'})`
}

const renderTable = (rows: string[][], header: string[]): string[] => {
  const all = [header, ...rows]
  const widths = header.map((_, column) => Math.max(...all.map((row) => row[column].length)))
  return all.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd(),
  )
}

export const ls = async (argv: string[], deps: EngineDeps) => {
  const { tabs, insideHerdr, log, warn, pluginConfigDir } = resolveDeps(deps)
  const flags = parseFlags(LS_COMMAND, argv)

  const repos = await resolveAllRepoConfigs(pluginConfigDir(), warn)
  const filter = flags.value('repo')
  const selected = filter ? repos.filter((repo) => repo.name === filter) : repos
  if (filter && selected.length === 0) {
    const known = repos.map((repo) => repo.name).join(', ') || '(none)'
    throw new Error(`no configured repo named ${filter} (known: ${known})`)
  }

  const inventories = selected
    .map((repo) => collectRepoInventory(repo.name, repo.config, warn))
    .filter((inventory): inventory is RepoInventory => inventory !== undefined)
    .map((inventory) => {
      if (!insideHerdr) return inventory
      // A Herdr hiccup degrades one repo's tab column, never the listing: this
      // is a read-only overview, not a teardown decision.
      try {
        const workspaceId = tabs.findWorkspace(inventory.root)
        return workspaceId ? attachTabFacts(inventory, tabs.listPanes(workspaceId)) : inventory
      } catch (error) {
        warn(`warning: could not read tabs for ${inventory.name}: ${error instanceof Error ? error.message : error}`)
        return inventory
      }
    })

  const worktrees = inventories.flatMap((inventory) =>
    inventory.worktrees.map((worktree) => ({ worktree, root: inventory.root })),
  )

  if (flags.flag('json')) {
    log(JSON.stringify(worktrees.map(({ worktree }) => toJson(worktree)), null, 2))
    return
  }

  if (worktrees.length === 0) {
    log(
      selected.length === 0
        ? 'no repos configured (treehouse onboard adds one)'
        : 'no worktrees (treehouse up creates one)',
    )
    return
  }

  const now = Date.now()
  const header = insideHerdr
    ? ['REPO', 'BRANCH', 'DIRTY', 'BASE', 'LAST', 'TAB', 'PATH']
    : ['REPO', 'BRANCH', 'DIRTY', 'BASE', 'LAST', 'PATH']
  const rows = worktrees.map(({ worktree, root }) => {
    // Sibling layout makes the path relative to the main checkout the short,
    // recognisable spelling (../my-repo-abc-1); unmanaged paths get a marker.
    const path = `${relative(root, worktree.path)}${worktree.managed ? '' : ' *'}`
    const shared = [
      worktree.repo,
      worktree.branch ?? '(detached)',
      dirtyCell(worktree),
      baseCell(worktree),
      age(worktree.lastCommitAt, now),
    ]
    return insideHerdr ? [...shared, tabCell(worktree), path] : [...shared, path]
  })
  for (const line of renderTable(rows, header)) log(line)
  if (worktrees.some(({ worktree }) => !worktree.managed)) {
    log('')
    log('* outside the repo’s worktree_dir convention (not created by treehouse)')
  }
}

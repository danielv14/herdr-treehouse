import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import {
  buildTemplateContext,
  expandArgv,
  expandTemplate,
  resolveRepoConfig,
  resolveWorktreePath,
  type RepoConfig,
  type TemplateContext,
} from './config.ts'
import { branchExists, findMainRepoRoot, git } from './git.ts'
import { herdr, insideHerdr } from './herdr.ts'

type UpOptions = {
  repo?: string
  branch?: string
  targets: string[]
  label?: string
  prompt?: string
  agent?: string
  noAgent: boolean
  noDev: boolean
  focus: boolean
  interactive: boolean
  fromLink: boolean
}

const parseUpArgs = (argv: string[]): UpOptions => {
  const options: UpOptions = {
    targets: [],
    noAgent: false,
    noDev: false,
    focus: false,
    interactive: false,
    fromLink: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--repo') options.repo = next()
    else if (arg === '--branch' || arg === '-b') options.branch = next()
    else if (arg === '--target' || arg === '-t') options.targets.push(next())
    else if (arg === '--targets') options.targets.push(...next().split(',').filter(Boolean))
    else if (arg === '--label') options.label = next()
    else if (arg === '--prompt') options.prompt = next()
    else if (arg === '--agent') options.agent = next()
    else if (arg === '--no-agent') options.noAgent = true
    else if (arg === '--no-dev') options.noDev = true
    else if (arg === '--focus') options.focus = true
    else if (arg === '--interactive') options.interactive = true
    else if (arg === '--from-link') options.fromLink = true
    else throw new Error(`unknown option for up: ${arg}`)
  }
  return options
}

// Runs after repo resolution so the popup can say which repo it targets and
// only ask questions that apply to it.
const askInteractively = async (options: UpOptions, repoName: string, repoConfig: RepoConfig) => {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  console.log(`New worktree tab in ${repoName}\n`)
  options.branch = (await readline.question('Branch name (e.g. ABC-1234/fix-thing): ')).trim()
  if (repoConfig.bootstrap?.includes('{targets...}')) {
    console.log('\nTargets: repo-relative dirs the bootstrap should install dependencies')
    console.log('for (e.g. services/foo, packages/bar). Leave empty to skip.')
    const targets = (await readline.question('Targets (comma-separated): ')).trim()
    if (targets !== '') options.targets.push(...targets.split(',').map((t) => t.trim()).filter(Boolean))
  }
  readline.close()
  options.focus = true
}

// A clicked link carries no judgment, so the engine stays mechanical: derive
// a wip branch and open the tab with a bare agent. What to DO about the
// ticket (explore, fix, just read up) is the user's or a skill's call; the
// engine never injects a task prompt on its own.
const applyLinkContext = (options: UpOptions) => {
  const url = process.env.HERDR_PLUGIN_CLICKED_URL ?? ''
  const jiraMatch = url.match(/atlassian\.net\/browse\/([A-Z]+-\d+)/)
  const githubMatch = url.match(/github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/)
  if (jiraMatch) {
    options.branch = `${jiraMatch[1]}/wip`
  } else if (githubMatch) {
    options.branch = `issue-${githubMatch[2]}/wip`
  } else {
    throw new Error(`could not derive a branch from clicked url: ${url}`)
  }
  options.focus = true
}

const runBootstrap = (repoConfig: RepoConfig, mainRepoRoot: string, context: TemplateContext) => {
  if (repoConfig.bootstrap) {
    const argv = expandArgv(repoConfig.bootstrap, context)
    console.log(`bootstrap: ${argv.join(' ')}`)
    const result = spawnSync(argv[0], argv.slice(1), { cwd: mainRepoRoot, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`bootstrap failed (exit ${result.status})`)
    return
  }
  if (existsSync(context.worktree)) {
    console.log(`worktree already exists: ${context.worktree}`)
    return
  }
  if (branchExists(mainRepoRoot, context.branch)) {
    git(mainRepoRoot, ['worktree', 'add', context.worktree, context.branch])
  } else {
    git(mainRepoRoot, ['worktree', 'add', context.worktree, '-b', context.branch, '--no-track', context.base])
  }
}

const runSetup = (repoConfig: RepoConfig, context: TemplateContext) => {
  for (const rawCommand of repoConfig.setup ?? []) {
    const command = expandTemplate(rawCommand, context)
    console.log(`setup: ${command}`)
    const result = spawnSync('bash', ['-lc', command], { cwd: context.worktree, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`setup command failed (exit ${result.status}): ${command}`)
  }
}

const findWorkspaceId = (mainRepoRoot: string): string => {
  try {
    const listed = herdr(['worktree', 'list', '--cwd', mainRepoRoot])
    if (listed?.source?.source_workspace_id) return listed.source.source_workspace_id
  } catch {
    // fall through to creating a workspace for the repo
  }
  const created = herdr(['workspace', 'create', '--cwd', mainRepoRoot, '--no-focus'])
  const workspaceId = created?.workspace?.workspace_id ?? created?.workspace_id
  if (!workspaceId) throw new Error('could not resolve a workspace for the repo')
  return workspaceId
}

export const up = async (argv: string[]) => {
  const options = parseUpArgs(argv)
  if (options.fromLink) applyLinkContext(options)
  if (!insideHerdr()) throw new Error('not inside a Herdr session (HERDR_ENV != 1)')

  // TREEHOUSE_REPO carries the focused workspace's cwd into the popup, whose own
  // cwd is the plugin root rather than the repo the user is working in.
  const startDir = options.repo ?? process.env.TREEHOUSE_REPO ?? process.cwd()
  const mainRepoRoot = findMainRepoRoot(startDir)
  const { name: repoName, config: repoConfig } = await resolveRepoConfig(mainRepoRoot)
  const base = repoConfig.base ?? 'origin/master'

  if (options.interactive) await askInteractively(options, repoName, repoConfig)
  if (!options.branch) throw new Error('up requires --branch (or --interactive / --from-link)')

  const partialContext = buildTemplateContext(repoName, options.branch, base, options.targets, mainRepoRoot)
  const worktreePath = resolveWorktreePath(repoConfig, mainRepoRoot, partialContext)
  const context: TemplateContext = { ...partialContext, worktree: worktreePath }

  const worktreeExistedBefore = existsSync(worktreePath)
  runBootstrap(repoConfig, mainRepoRoot, context)
  if (!existsSync(worktreePath)) {
    throw new Error(`bootstrap finished but worktree is missing: ${worktreePath}`)
  }
  // Setup only on a fresh worktree: re-running `up` on an existing one should
  // not trigger another npm ci.
  if (!worktreeExistedBefore) runSetup(repoConfig, context)

  const workspaceId = findWorkspaceId(mainRepoRoot)
  const label = options.label ?? context.id
  const tab = herdr([
    'tab', 'create',
    '--workspace', workspaceId,
    '--cwd', worktreePath,
    '--label', label,
    options.focus ? '--focus' : '--no-focus',
  ])
  const tabId = tab.tab.tab_id
  const mainPaneId = tab.root_pane.pane_id

  const paneSummaries: string[] = []
  if (!options.noDev) {
    let previousPaneId = mainPaneId
    for (const paneConfig of repoConfig.panes ?? []) {
      const split = herdr([
        'pane', 'split', previousPaneId,
        '--direction', paneConfig.split ?? 'down',
        '--ratio', String(paneConfig.ratio ?? 0.5),
        '--cwd', worktreePath,
        '--no-focus',
      ])
      const paneId = split.pane.pane_id as string
      if (paneConfig.label) herdr(['pane', 'rename', paneId, paneConfig.label])
      if (paneConfig.command) {
        const command = expandTemplate(paneConfig.command, context)
        if (paneConfig.autostart) {
          herdr(['pane', 'run', paneId, command])
          paneSummaries.push(`${paneId}${paneConfig.label ? ` (${paneConfig.label})` : ''}: "${command}" started`)
        } else {
          // Pre-fill without Enter: verification is one keypress away, but two
          // tabs never end up racing for the same docker containers/ports.
          herdr(['pane', 'send-text', paneId, command])
          paneSummaries.push(`${paneId}${paneConfig.label ? ` (${paneConfig.label})` : ''}: "${command}" prefilled (press Enter to start)`)
        }
      } else {
        paneSummaries.push(`${paneId}${paneConfig.label ? ` (${paneConfig.label})` : ''}: shell`)
      }
      previousPaneId = paneId
    }
  }

  const agent = options.agent ?? repoConfig.agent ?? 'claude'
  if (!options.noAgent) {
    herdr(['pane', 'run', mainPaneId, agent])
    if (options.prompt) {
      herdr(['wait', 'agent-status', mainPaneId, '--status', 'idle', '--timeout', '60000'])
      herdr(['pane', 'run', mainPaneId, options.prompt])
    }
  }

  console.log(`worktree:  ${worktreePath}`)
  console.log(`branch:    ${context.branch}`)
  console.log(`tab:       ${tabId} (${label}) in workspace ${workspaceId}`)
  for (const summary of paneSummaries) console.log(`pane:      ${summary}`)
  if (!options.noAgent) console.log(`agent:     ${agent} in ${mainPaneId}`)
}

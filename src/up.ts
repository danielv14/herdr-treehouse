import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import {
  buildTemplateContext,
  expandArgv,
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

const askInteractively = async (options: UpOptions) => {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  options.branch = (await readline.question('Branch (t.ex. VKT-1234/fix-thing): ')).trim()
  const targets = (await readline.question('Targets, kommaseparerade (tomt för inga): ')).trim()
  if (targets !== '') options.targets.push(...targets.split(',').map((t) => t.trim()).filter(Boolean))
  readline.close()
  options.focus = true
}

// A clicked link carries no judgment, so derive a mechanical wip branch and
// let the agent in the new tab rename it once it has read the ticket.
const applyLinkContext = (options: UpOptions) => {
  const url = process.env.HERDR_PLUGIN_CLICKED_URL ?? ''
  const jiraMatch = url.match(/atlassian\.net\/browse\/([A-Z]+-\d+)/)
  const githubMatch = url.match(/github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/)
  if (jiraMatch) {
    options.branch = `${jiraMatch[1]}/wip`
    options.prompt = [
      `Läs på om ${jiraMatch[1]} (${url}).`,
      'Du står i ett nyskapat git worktree med en tillfällig branch.',
      'Döp om branchen enligt repots konventioner (git branch -m) och lös sedan ärendet.',
    ].join(' ')
  } else if (githubMatch) {
    options.branch = `issue-${githubMatch[2]}/wip`
    options.prompt = [
      `Läs GitHub-issue ${url} (t.ex. via gh issue view ${githubMatch[2]}).`,
      'Du står i ett nyskapat git worktree med en tillfällig branch.',
      'Döp om branchen om det behövs och lös sedan ärendet.',
    ].join(' ')
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
  if (options.interactive) await askInteractively(options)
  if (options.fromLink) applyLinkContext(options)
  if (!options.branch) throw new Error('up requires --branch (or --interactive / --from-link)')
  if (!insideHerdr()) throw new Error('not inside a Herdr session (HERDR_ENV != 1)')

  const startDir = options.repo ?? process.cwd()
  const mainRepoRoot = findMainRepoRoot(startDir)
  const { name: repoName, config: repoConfig } = await resolveRepoConfig(mainRepoRoot)
  const base = repoConfig.base ?? 'origin/master'

  const partialContext = buildTemplateContext(repoName, options.branch, base, options.targets)
  const worktreePath = resolveWorktreePath(repoConfig, mainRepoRoot, partialContext)
  const context: TemplateContext = { ...partialContext, worktree: worktreePath }

  runBootstrap(repoConfig, mainRepoRoot, context)
  if (!existsSync(worktreePath)) {
    throw new Error(`bootstrap finished but worktree is missing: ${worktreePath}`)
  }

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

  let devPaneId: string | undefined
  if (repoConfig.dev_command && !options.noDev) {
    const split = herdr([
      'pane', 'split', mainPaneId,
      '--direction', repoConfig.dev_split ?? 'down',
      '--ratio', String(repoConfig.dev_ratio ?? 0.3),
      '--cwd', worktreePath,
      '--no-focus',
    ])
    devPaneId = split.pane.pane_id as string
    herdr(['pane', 'rename', devPaneId, 'dev'])
    if (repoConfig.dev_autostart) {
      herdr(['pane', 'run', devPaneId, repoConfig.dev_command])
    } else {
      // Pre-fill without Enter: verification is one keypress away, but two
      // tabs never end up racing for the same docker containers/ports.
      herdr(['pane', 'send-text', devPaneId, repoConfig.dev_command])
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
  console.log(`tab:       ${tabId} (${label}) i workspace ${workspaceId}`)
  if (devPaneId) {
    console.log(`dev pane:  ${devPaneId} — "${repoConfig.dev_command}" ${repoConfig.dev_autostart ? 'startad' : 'förifylld (tryck Enter för att starta)'}`)
  }
  if (!options.noAgent) console.log(`agent:     ${agent} i ${mainPaneId}`)
}

import { branchFromUrl } from '../worktree/branch.ts'
import { parseFlags, type CommandSpec } from '../cli.ts'
import { PANE_DEFAULTS, resolveRepoConfig, type RepoConfig } from '../config/config.ts'
import { invocationTargetPath, isPluginInvocation, readInvocationContext } from '../herdr/context.ts'
import { resolveDeps, type Ask, type EngineDeps } from '../deps.ts'
import { countLinkedWorktrees, findMainRepoRoot } from '../worktree/git.ts'
import { bootstrapTakesTargets, buildWorktreePlan } from '../worktree/plan.ts'
import { provisionWorktree } from '../worktree/provision.ts'
import type { PaneSpec } from '../herdr/tabs.ts'

export const UP_COMMAND: CommandSpec = {
  name: 'up',
  usage: [
    'treehouse up --branch <name> [--target <dir>]... [options]',
    'treehouse up --interactive',
  ],
  summary: 'bootstrap a worktree (per repo config) and open it as a Herdr tab',
  flags: [
    { flag: '--repo', kind: 'value', key: 'repo', placeholder: '<path>', help: 'repo to operate on (default: repo of cwd)' },
    { flag: '--branch', alias: '-b', kind: 'value', key: 'branch', placeholder: '<name>', help: 'branch name, e.g. ABC-1234/fix-thing' },
    { flag: '--target', alias: '-t', kind: 'list', key: 'targets', placeholder: '<dir>', help: 'repo-relative dir passed to the bootstrap script (repeatable)' },
    { flag: '--targets', kind: 'list', key: 'targets', split: ',', placeholder: '<a,b>', help: 'comma-separated form of --target' },
    { flag: '--label', kind: 'value', key: 'label', placeholder: '<text>', help: 'tab label (default: ticket id or branch slug, prefixed with a tree)' },
    { flag: '--prompt', kind: 'value', key: 'prompt', placeholder: '<text>', help: 'task to hand the agent once it is idle' },
    { flag: '--agent', kind: 'value', key: 'agent', placeholder: '<cmd>', help: 'agent command (default: repo config, [defaults], then claude)' },
    { flag: '--no-agent', kind: 'boolean', key: 'noAgent', help: 'skip starting an agent in the main pane' },
    { flag: '--no-dev', kind: 'boolean', key: 'noDev', help: 'skip the extra panes from repo config' },
    { flag: '--focus', kind: 'boolean', key: 'focus', help: 'focus the new tab (default: stay where you are)' },
    { flag: '--interactive', kind: 'boolean', key: 'interactive', help: 'ask for branch and targets in a popup pane (used by the keybinding action)' },
    { flag: '--from-link', kind: 'boolean', key: 'fromLink', help: 'derive the branch from a ctrl+clicked Jira/GitHub link (used by the link handlers)' },
  ],
}

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

const readOptions = (argv: string[]): UpOptions => {
  const flags = parseFlags(UP_COMMAND, argv)
  return {
    repo: flags.value('repo'),
    branch: flags.value('branch'),
    targets: flags.list('targets'),
    label: flags.value('label'),
    prompt: flags.value('prompt'),
    agent: flags.value('agent'),
    noAgent: flags.flag('noAgent'),
    noDev: flags.flag('noDev'),
    focus: flags.flag('focus'),
    interactive: flags.flag('interactive'),
    fromLink: flags.flag('fromLink'),
  }
}

// Runs after repo resolution so the popup can say which repo it targets and
// only ask questions that apply to it.
const askInteractively = async (
  repoConfig: RepoConfig,
  repoName: string,
  io: { log: (message: string) => void; ask: Ask },
): Promise<{ branch: string; targets: string[] }> => {
  io.log(`New worktree tab in ${repoName}\n`)
  const branch = (await io.ask('Branch name (e.g. ABC-1234/fix-thing): ')).trim()
  const targets: string[] = []
  if (bootstrapTakesTargets(repoConfig)) {
    io.log('\nTargets: repo-relative dirs the bootstrap should install dependencies')
    io.log('for (e.g. services/foo, packages/bar). Leave empty to skip.')
    const answer = (await io.ask('Targets (comma-separated): ')).trim()
    if (answer !== '') targets.push(...answer.split(',').map((target) => target.trim()).filter(Boolean))
  }
  return { branch, targets }
}

const paneSpecs = (repoConfig: RepoConfig, expand: (template: string, where?: string) => string): PaneSpec[] =>
  (repoConfig.panes ?? []).map((pane) => ({
    split: pane.split ?? PANE_DEFAULTS.split,
    ratio: pane.ratio ?? PANE_DEFAULTS.ratio,
    label: pane.label,
    command: pane.command ? expand(pane.command, 'a pane command') : undefined,
    autostart: pane.autostart ?? PANE_DEFAULTS.autostart,
  }))

export const up = async (argv: string[], deps: EngineDeps) => {
  const { tabs, env, insideHerdr, log, warn, ask, pluginConfigDir } = resolveDeps(deps)
  const options = readOptions(argv)
  // A clicked link and an interactive answer both mean "take me there", which
  // is why either one focuses the tab that a bare --branch leaves in the
  // background.
  if (options.fromLink) {
    const url = readInvocationContext(env).clickedUrl
    const branch = branchFromUrl(url)
    if (!branch) throw new Error(`could not derive a branch from clicked url: ${url ?? '(none)'}`)
    options.branch = branch
    options.focus = true
  }
  if (!insideHerdr) throw new Error('not inside a Herdr session (HERDR_ENV != 1)')

  const target = invocationTargetPath({ explicit: options.repo, prefer: 'pane', env })
  if (!target && options.fromLink) {
    throw new Error('link invocation: could not derive the target repo from the plugin context')
  }
  // Falling back to cwd for a plugin-invoked run would target the plugin repo
  // itself, so refuse rather than bootstrap a worktree of treehouse.
  if (!target && isPluginInvocation(env)) {
    throw new Error('plugin invocation: could not derive the target repo from the plugin context (refusing to fall back to the plugin repo)')
  }
  const mainRepoRoot = findMainRepoRoot(target ?? process.cwd())
  const { name: repoName, config: repoConfig } = await resolveRepoConfig(mainRepoRoot, pluginConfigDir(), warn)

  if (options.interactive) {
    const answers = await askInteractively(repoConfig, repoName, { log, ask })
    options.branch = answers.branch
    options.targets.push(...answers.targets)
    options.focus = true
  }
  if (!options.branch) throw new Error('up requires --branch (or --interactive / --from-link)')
  // Silently dropping the task would be worse than refusing: the tab would open
  // and nothing would ever act on it.
  if (options.prompt && options.noAgent) {
    throw new Error('--prompt needs an agent to hand the task to (drop --no-agent, or drop --prompt)')
  }

  const plan = buildWorktreePlan({
    repoName,
    branch: options.branch,
    mainRepoRoot,
    repoConfig,
    targets: options.targets,
  })

  // Expand the pane commands before provisioning: a placeholder typo in a pane
  // command should fail before a worktree exists, not after npm ci.
  const panes = options.noDev ? [] : paneSpecs(repoConfig, plan.expand)

  provisionWorktree(plan, repoConfig, { log, warn })

  // repoConfig.agent already has [defaults].agent layered under it; bare
  // `claude` is the last resort so the user's own Claude Code settings decide
  // things like permission mode when nothing here is configured.
  const agent = options.agent ?? repoConfig.agent ?? 'claude'
  // The tree marks worktree tabs apart from ordinary ones everywhere a tab
  // label shows (tab list, the sidebar's agent rows). An explicit --label is
  // the caller's to spell, prefix included.
  const label = options.label ?? `🌳 ${plan.id}`
  const workspaceId = tabs.resolveWorkspace(mainRepoRoot)

  // Report the sidebar token before the tab choreography: the count changed at
  // provisioning, and the agent handshake ahead can take a minute or throw,
  // neither of which may leave the token stale (Herdr's worktree events do not
  // see our git-side changes). Best-effort: a failed report never fails up.
  try {
    tabs.reportWorktreeCount(workspaceId, countLinkedWorktrees(mainRepoRoot))
  } catch (error) {
    warn(`warning: could not report the worktree count: ${error instanceof Error ? error.message : error}`)
  }

  const opened = await tabs.openWorktreeTab({
    workspaceId,
    cwd: plan.worktree,
    label,
    focus: options.focus,
    panes,
    agent: options.noAgent ? undefined : agent,
    prompt: options.prompt,
  })

  log(`worktree:  ${plan.worktree}`)
  log(`branch:    ${plan.branch}`)
  log(`tab:       ${opened.tabId} (${label}) in workspace ${workspaceId}`)
  for (const pane of opened.panes) {
    const name = pane.label ? ` (${pane.label})` : ''
    const state = pane.command
      ? pane.started
        ? `"${pane.command}" started`
        : `"${pane.command}" prefilled (press Enter to start)`
      : 'shell'
    log(`pane:      ${pane.paneId}${name}: ${state}`)
  }
  if (opened.agentStarted) log(`agent:     ${agent} in ${opened.mainPaneId}`)
}

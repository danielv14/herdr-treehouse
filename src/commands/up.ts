import { branchFromUrl } from '../worktree/branch.ts'
import { parseFlags, type CommandSpec } from '../cli.ts'
import { resolveRepoConfig, type RepoConfig } from '../config/config.ts'
import { readInvocationContext, requireInvocationTarget } from '../herdr/context.ts'
import { resolveDeps, type Ask, type EngineDeps } from '../deps.ts'
import { findMainRepoRoot } from '../worktree/git.ts'
import { refreshWorktreeCount } from '../worktreeCount.ts'
import { bootstrapTakesTargets, buildWorktreePlan } from '../worktree/plan.ts'
import { resolveWorktreePlacement } from '../worktree/placement.ts'
import { prepareAgentCommand } from '../worktree/agentContext.ts'
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
    { flag: '--model', kind: 'value', key: 'model', placeholder: '<name>', help: "model for this tab's agent, filled into the repo's model_arg (default: the agent's own)" },
    { flag: '--no-agent', kind: 'boolean', key: 'noAgent', help: 'skip starting an agent in the main pane' },
    { flag: '--no-dev', kind: 'boolean', key: 'noDev', help: 'skip the extra panes from repo config' },
    { flag: '--setup', kind: 'boolean', key: 'setup', help: 'run the repo setup commands even if the worktree already exists' },
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
  model?: string
  noAgent: boolean
  noDev: boolean
  setup: boolean
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
    model: flags.value('model'),
    noAgent: flags.flag('noAgent'),
    noDev: flags.flag('noDev'),
    setup: flags.flag('setup'),
    focus: flags.flag('focus'),
    interactive: flags.flag('interactive'),
    fromLink: flags.flag('fromLink'),
  }
}

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

// The panes arrive with their defaults applied, so expanding the command is all
// that is left. The spread is also where a config pane becomes a Herdr one: a
// key added to the config shape reaches the tab request from here.
const paneSpecs = (repoConfig: RepoConfig, expand: (template: string, where?: string) => string): PaneSpec[] =>
  repoConfig.panes.map((pane) => ({
    ...pane,
    command: pane.command ? expand(pane.command, 'a pane command') : undefined,
  }))

export const up = async (argv: string[], deps: EngineDeps) => {
  const { tabs, env, insideHerdr, log, warn, ask, run, pluginConfigDir } = resolveDeps(deps)
  const options = readOptions(argv)
  // A clicked link means "take me there", so it focuses the tab that a bare
  // --branch leaves in the background; the interactive popup does the same.
  if (options.fromLink) {
    const url = readInvocationContext(env).clickedUrl
    const branch = branchFromUrl(url)
    if (!branch) throw new Error(`could not derive a branch from clicked url: ${url ?? '(none)'}`)
    options.branch = branch
    options.focus = true
  }
  if (!insideHerdr) throw new Error('not inside a Herdr session (HERDR_ENV != 1)')

  const mainRepoRoot = findMainRepoRoot(
    requireInvocationTarget({ explicit: options.repo, prefer: 'pane', env, cwd: process.cwd() }),
  )
  // One resolution for both readers: the config is looked up in it, and the plan
  // hands it to {config_dir}, so they cannot disagree about where it is.
  const configDir = pluginConfigDir()
  const { name: repoName, config: repoConfig } = await resolveRepoConfig(mainRepoRoot, configDir, warn)

  if (options.interactive) {
    const answers = await askInteractively(repoConfig, repoName, { log, ask })
    options.branch = answers.branch
    options.targets.push(...answers.targets)
    options.focus = true
  }
  if (!options.branch) throw new Error('up requires --branch (or --interactive / --from-link)')
  // Silently dropping the task would open a tab nothing ever acts on.
  if (options.prompt && options.noAgent) {
    throw new Error('--prompt needs an agent to hand the task to (drop --no-agent, or drop --prompt)')
  }
  if (options.model && options.noAgent) {
    throw new Error('--model needs an agent to apply to (drop --no-agent, or drop --model)')
  }

  // Where this branch's worktree goes, asked once and answered in one place:
  // an existing worktree keeps its own path and name, a new one takes the first
  // free spot the convention allows, and both refusals come from there.
  const placement = resolveWorktreePlacement({
    repoName,
    branch: options.branch,
    mainRepoRoot,
    repoConfig,
  })

  const plan = buildWorktreePlan({
    repoName,
    branch: options.branch,
    mainRepoRoot,
    repoConfig,
    configDir,
    targets: options.targets,
    worktree: placement.worktree,
    id: placement.id,
  })

  // Pane and agent commands expand before provisioning: a placeholder typo, or
  // a half-configured context, should fail before a worktree exists, not after
  // npm ci.
  const panes = options.noDev ? [] : paneSpecs(repoConfig, plan.expand)
  // repoConfig.agent already has [defaults].agent layered under it; bare
  // `claude` is the last resort so the user's own Claude Code settings decide
  // things like permission mode when nothing here is configured. --no-agent
  // needs neither an agent command nor a context, and writes no context file.
  const agent = options.noAgent
    ? undefined
    : prepareAgentCommand(plan, {
        command: options.agent ?? repoConfig.agent ?? 'claude',
        context: repoConfig.context,
        modelArg: repoConfig.model_arg,
        model: options.model,
      })

  provisionWorktree(plan, repoConfig, { setupExisting: options.setup, run, log, warn })
  // An explicit --label is the caller's to spell, tree prefix included.
  const label = options.label ?? `🌳 ${plan.id}`
  const workspaceId = tabs.resolveWorkspace(mainRepoRoot)

  // Before the tab choreography: the agent handshake ahead can take a minute
  // or throw, neither of which may leave the token stale (Herdr's worktree
  // events do not see our git-side changes).
  refreshWorktreeCount(tabs, workspaceId, mainRepoRoot, warn)

  const opened = await tabs.openWorktreeTab({
    workspaceId,
    cwd: plan.worktree,
    label,
    focus: options.focus,
    panes,
    agent: agent?.command,
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
  if (agent && opened.agentStarted) log(`agent:     ${agent.command} in ${opened.mainPaneId}`)
  if (agent?.contextFile) log(`context:   ${agent.contextFile}`)
}

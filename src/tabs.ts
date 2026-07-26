import type { HerdrInvoker } from './herdr.ts'

// The one place that knows Herdr: subcommand names, response shapes and the
// version-specific quirks. Responses are decoded into typed values here, so
// `up` and `down` read fields instead of digging through `any`, and Herdr drift
// lands in one implementation.

export type PaneSpec = {
  split: 'down' | 'right'
  ratio: number
  label?: string
  command?: string
  autostart: boolean
}

export type OpenTabRequest = {
  workspaceId: string
  cwd: string
  label: string
  focus: boolean
  panes: PaneSpec[]
  // Command that starts the coding agent in the main pane; undefined = no agent.
  agent?: string
  // Task handed to the agent once it reports idle. Ignored without an agent.
  prompt?: string
}

export type OpenedPane = {
  paneId: string
  label?: string
  command?: string
  // A command was started (autostart) rather than only pre-filled.
  started: boolean
}

export type OpenedTab = {
  tabId: string
  mainPaneId: string
  panes: OpenedPane[]
  agentStarted: boolean
}

export type BusyPane = { paneId: string; command: string }

export type TabInspection = {
  tabIds: string[]
  busyPanes: BusyPane[]
}

export type PluginPaneRequest = {
  entrypoint: string
  env?: Record<string, string>
}

export type TabChoreography = {
  // Workspace of a repo, or undefined when the repo has none open.
  findWorkspace: (mainRepoRoot: string) => string | undefined
  // Same lookup, creating the workspace when the repo has none.
  resolveWorkspace: (mainRepoRoot: string) => string
  openWorktreeTab: (request: OpenTabRequest) => Promise<OpenedTab>
  // Which tabs the worktree occupies, and which of its panes are genuinely busy.
  inspectWorktreeTab: (
    workspaceId: string,
    worktreePath: string,
    options?: { ignorePaneId?: string },
  ) => Promise<TabInspection>
  // Closes tabs, `lastTabId` last: an agent driving a teardown from inside the
  // worktree tab dies with it, so everything else has to be done first.
  closeTabs: (tabIds: string[], options?: CloseTabsOptions) => void
  openPluginPane: (request: PluginPaneRequest) => void
}

export type CloseTabsOptions = {
  lastTabId?: string
  onClosed?: (tabId: string) => void
}

// --- response decoding ------------------------------------------------------

const asTable = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const readString = (value: unknown, ...path: string[]): string | undefined => {
  let current: unknown = value
  for (const key of path) current = asTable(current)[key]
  return typeof current === 'string' ? current : undefined
}

const requireString = (value: unknown, path: string[], call: string): string => {
  const found = readString(value, ...path)
  if (found === undefined) throw new Error(`herdr ${call}: response has no ${path.join('.')}`)
  return found
}

const readList = (value: unknown, ...path: string[]): unknown[] => {
  let current: unknown = value
  for (const key of path) current = asTable(current)[key]
  return Array.isArray(current) ? current : []
}

// Shells are always "running" in a pane; they are not what blocks a teardown.
const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', '-zsh', '-bash'])

// A registered agent that is idle or done is just waiting at its prompt, and
// tearing it down with the tab is the whole point. Only agents mid-work (or
// blocked on input) and non-agent processes count as busy.
const IDLE_AGENT_STATUSES = new Set(['idle', 'done'])

const defaultSleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// Prompt tooling (starship etc.) spawns short-lived processes on every prompt
// render, so a single busy snapshot gives false positives.
const BUSY_RECHECK_MS = 750

// How long to wait for an agent to reach idle, and how often to retry while
// Herdr has not registered it yet.
const AGENT_IDLE_TIMEOUT_MS = 60_000
const AGENT_REGISTRATION_POLL_MS = 500

// A freshly started agent can report idle while its TUI is still starting, and a
// prompt submitted in that window is dropped on the floor (live-observed on
// herdr 0.7.5: the tab opens, the task never arrives). `agent prompt --wait`
// requires an observed state change and reports agent_prompt_stalled when the
// text was not picked up, which is the signal to submit again.
const PROMPT_DELIVERY_TIMEOUT_MS = 5000
const PROMPT_RETRY_MS = 1000
const PROMPT_ATTEMPTS = 3

export const createTabChoreography = (
  invoke: HerdrInvoker,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): TabChoreography => {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now

  // A repo with no open workspace is a normal answer, and Herdr reports it by
  // leaving source_workspace_id out of a successful response. A thrown error is
  // therefore a real failure and is NOT swallowed: `down` decides whether to
  // tear a worktree down based on this, and degrading to "no workspace" would
  // skip the busy-process check entirely.
  const findWorkspace = (mainRepoRoot: string): string | undefined =>
    readString(invoke(['worktree', 'list', '--cwd', mainRepoRoot]), 'source', 'source_workspace_id')

  const resolveWorkspace = (mainRepoRoot: string): string => {
    let existing: string | undefined
    try {
      existing = findWorkspace(mainRepoRoot)
    } catch {
      // Opening a tab can recover from a failed lookup by creating the
      // workspace; the worst case is one extra workspace, not a lost worktree.
      existing = undefined
    }
    if (existing) return existing
    const created = invoke(['workspace', 'create', '--cwd', mainRepoRoot, '--no-focus'])
    const workspaceId =
      readString(created, 'workspace', 'workspace_id') ?? readString(created, 'workspace_id')
    if (!workspaceId) throw new Error('could not resolve a workspace for the repo')
    return workspaceId
  }

  // Herdr registers an agent only once its detection has seen the process, so
  // `agent wait` answers agent_not_found for the first moment after `pane run`.
  // Retry that one error until the agent shows up; everything else is real.
  const waitForAgentIdle = async (paneId: string) => {
    const deadline = now() + AGENT_IDLE_TIMEOUT_MS
    for (;;) {
      const remaining = deadline - now()
      if (remaining <= 0) throw new Error(`no agent registered in ${paneId} within ${AGENT_IDLE_TIMEOUT_MS}ms`)
      try {
        invoke(['agent', 'wait', paneId, '--until', 'idle', '--timeout', String(remaining)])
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('agent_not_found')) throw error
        await sleep(AGENT_REGISTRATION_POLL_MS)
      }
    }
  }

  // Retries only on the explicit "nothing was picked up" code, so a delivered
  // prompt is never submitted twice; anything else fails loudly, because a tab
  // that silently never received its task is worse than an error.
  const submitPrompt = async (paneId: string, prompt: string) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        invoke([
          'agent', 'prompt', paneId, prompt,
          '--wait', '--until', 'working',
          '--timeout', String(PROMPT_DELIVERY_TIMEOUT_MS),
        ])
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('agent_prompt_stalled') || attempt >= PROMPT_ATTEMPTS) {
          throw new Error(`could not hand the prompt to the agent in ${paneId}: ${message}`)
        }
        await sleep(PROMPT_RETRY_MS)
      }
    }
  }

  const openWorktreeTab = async (request: OpenTabRequest): Promise<OpenedTab> => {
    const tab = invoke([
      'tab', 'create',
      '--workspace', request.workspaceId,
      '--cwd', request.cwd,
      '--label', request.label,
      request.focus ? '--focus' : '--no-focus',
    ])
    const tabId = requireString(tab, ['tab', 'tab_id'], 'tab create')
    const mainPaneId = requireString(tab, ['root_pane', 'pane_id'], 'tab create')

    const panes: OpenedPane[] = []
    // Each entry splits the PREVIOUS pane; the first splits the main/agent pane.
    let previousPaneId = mainPaneId
    for (const pane of request.panes) {
      const split = invoke([
        'pane', 'split', previousPaneId,
        '--direction', pane.split,
        '--ratio', String(pane.ratio),
        '--cwd', request.cwd,
        '--no-focus',
      ])
      const paneId = requireString(split, ['pane', 'pane_id'], 'pane split')
      if (pane.label) invoke(['pane', 'rename', paneId, pane.label])
      let started = false
      if (pane.command) {
        if (pane.autostart) {
          invoke(['pane', 'run', paneId, pane.command])
          started = true
        } else {
          // Pre-fill without Enter: verification is one keypress away, but two
          // tabs never end up racing for the same docker containers/ports.
          invoke(['pane', 'send-text', paneId, pane.command])
        }
      }
      panes.push({ paneId, label: pane.label, command: pane.command, started })
      previousPaneId = paneId
    }

    if (request.agent) {
      // The agent command is a free-form string from config, so it starts as a
      // pane command; Herdr detects and registers the agent from there.
      invoke(['pane', 'run', mainPaneId, request.agent])
      if (request.prompt) {
        // Wait for the agent to be ready for input, then hand the prompt to
        // `agent prompt`, which owns submission. Both live-verified on herdr
        // 0.7.5; the previous `wait agent-status` + `pane run` + explicit Enter
        // sequence was a 0.7.4 workaround for bracketed paste swallowing the
        // trailing Enter, and `wait agent-status` is gone as of 0.7.5.
        await waitForAgentIdle(mainPaneId)
        await submitPrompt(mainPaneId, request.prompt)
      }
    }

    return { tabId, mainPaneId, panes, agentStarted: Boolean(request.agent) }
  }

  const busyProcesses = (paneId: string): string[] => {
    // Always an explicit --pane: `--current` resolves against the UI-focused
    // pane, which may belong to another workspace entirely (herdr 0.7.x).
    const info = invoke(['pane', 'process-info', '--pane', paneId])
    return readList(info, 'process_info', 'foreground_processes')
      .filter((process_) => !SHELL_NAMES.has(readString(process_, 'name') ?? ''))
      .map((process_) => readString(process_, 'cmdline') ?? readString(process_, 'name') ?? 'unknown process')
  }

  const confirmedBusyProcesses = async (paneId: string): Promise<string[]> => {
    if (busyProcesses(paneId).length === 0) return []
    await sleep(BUSY_RECHECK_MS)
    return busyProcesses(paneId)
  }

  const inspectWorktreeTab = async (
    workspaceId: string,
    worktreePath: string,
    inspectOptions: { ignorePaneId?: string } = {},
  ): Promise<TabInspection> => {
    const listed = invoke(['pane', 'list', '--workspace', workspaceId])
    const prefix = worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`
    const panes = readList(listed, 'panes')
      .map((pane) => ({
        paneId: readString(pane, 'pane_id') ?? '',
        tabId: readString(pane, 'tab_id') ?? '',
        cwd: readString(pane, 'cwd'),
        agent: readString(pane, 'agent'),
        agentStatus: readString(pane, 'agent_status'),
      }))
      .filter((pane) => pane.cwd === worktreePath || pane.cwd?.startsWith(prefix))

    const busyPanes: BusyPane[] = []
    for (const pane of panes) {
      if (pane.paneId === '' || pane.paneId === inspectOptions.ignorePaneId) continue
      if (pane.agent && IDLE_AGENT_STATUSES.has(pane.agentStatus ?? '')) continue
      for (const command of await confirmedBusyProcesses(pane.paneId)) {
        busyPanes.push({ paneId: pane.paneId, command })
      }
    }

    return { tabIds: [...new Set(panes.map((pane) => pane.tabId).filter((id) => id !== ''))], busyPanes }
  }

  const closeTabs = (tabIds: string[], closeOptions: CloseTabsOptions = {}) => {
    const ordered = [...tabIds].sort(
      (a, b) => Number(a === closeOptions.lastTabId) - Number(b === closeOptions.lastTabId),
    )
    for (const tabId of ordered) {
      invoke(['tab', 'close', tabId])
      closeOptions.onClosed?.(tabId)
    }
  }

  const openPluginPane = (request: PluginPaneRequest) => {
    const args = [
      'plugin', 'pane', 'open',
      '--plugin', 'treehouse',
      '--entrypoint', request.entrypoint,
      '--placement', 'popup',
      '--focus',
    ]
    for (const [key, value] of Object.entries(request.env ?? {})) {
      args.push('--env', `${key}=${value}`)
    }
    invoke(args)
  }

  return {
    findWorkspace,
    resolveWorkspace,
    openWorktreeTab,
    inspectWorktreeTab,
    closeTabs,
    openPluginPane,
  }
}

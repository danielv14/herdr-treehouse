// The only reader of the payloads Herdr hands the engine through the
// environment. Both payloads decode tolerantly (raw kept for the plugin log,
// fields read as absent): a malformed payload may not take an invocation down.

// Plugin-invoked processes run with cwd = plugin root, so the target path has
// to be carried explicitly.
export const TARGET_PATH_ENV = 'TREEHOUSE_TARGET_PATH'

export type Environment = Record<string, string | undefined>

export type InvocationContext = {
  // Raw payload, kept for logging: the plugin log is how an unexpected shape
  // gets noticed.
  raw?: string
  workspaceCwd?: string
  focusedPaneCwd?: string
  focusedPaneId?: string
  clickedUrl?: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export const readInvocationContext = (env: Environment): InvocationContext => {
  const raw = env.HERDR_PLUGIN_CONTEXT_JSON
  const clickedFromEnv = env.HERDR_PLUGIN_CLICKED_URL
  if (!raw) return { clickedUrl: clickedFromEnv || undefined }
  let parsed: Record<string, unknown> = {}
  try {
    const candidate = JSON.parse(raw)
    if (isObject(candidate)) parsed = candidate
  } catch {
    // Malformed: raw still goes back for the log, fields read as absent.
  }
  return {
    raw,
    workspaceCwd: readString(parsed, 'workspace_cwd'),
    focusedPaneCwd: readString(parsed, 'focused_pane_cwd'),
    focusedPaneId: readString(parsed, 'focused_pane_id'),
    clickedUrl: clickedFromEnv || readString(parsed, 'clicked_url'),
  }
}

export const isPluginInvocation = (env: Environment) =>
  env.HERDR_PLUGIN_CONTEXT_JSON !== undefined

export type WorktreeCreatedEvent = {
  raw?: string
  path?: string
  branch?: string
}

// Payload shape confirmed live on herdr 0.7.5 and matching `herdr api schema`:
// { event, data: { type, workspace, worktree: { path, branch, ... } } }.
export const readWorktreeCreatedEvent = (env: Environment): WorktreeCreatedEvent => {
  const raw = env.HERDR_PLUGIN_EVENT_JSON
  if (!raw) return {}
  let worktree: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    const data = isObject(parsed) ? parsed.data : undefined
    const candidate = isObject(data) ? data.worktree : undefined
    if (isObject(candidate)) worktree = candidate
  } catch {
    // Malformed: raw still goes back for the log, fields read as absent. An
    // uncaught throw here would take down the hook, the one unattended path.
  }
  return { raw, path: readString(worktree, 'path'), branch: readString(worktree, 'branch') }
}

export type TargetPathInput = {
  explicit?: string
  // 'pane' for anything about the focused worktree (teardown, a clicked link),
  // 'workspace' for anything about the repo as a whole.
  prefer: 'pane' | 'workspace'
  env: Environment
}

// Precedence: explicit flag, then TARGET_PATH_ENV, then the invocation context.
// Undefined means nothing said; what to do about it is the caller's decision.
export const invocationTargetPath = ({
  explicit,
  prefer,
  env,
}: TargetPathInput): string | undefined => {
  if (explicit) return explicit
  const fromEnv = env[TARGET_PATH_ENV]
  if (fromEnv) return fromEnv
  const context = readInvocationContext(env)
  return prefer === 'workspace'
    ? (context.workspaceCwd ?? context.focusedPaneCwd)
    : (context.focusedPaneCwd ?? context.workspaceCwd)
}

// The caller's own pane/tab: teardown skips itself in the busy check and
// closes its own tab last.
export const callerPaneId = (env: Environment) => env.HERDR_PANE_ID
export const callerTabId = (env: Environment) => env.HERDR_TAB_ID

// The only reader of Herdr's plugin invocation context. "Which repo or worktree
// was the user in" used to be answered in three places (a bun -e snippet in each
// action script, plus the engine) and carried onward through two env conventions
// for the same fact; this module and TARGET_PATH_ENV replace all of that.

// Plugin-invoked processes (actions, link handlers, plugin panes) run with
// cwd = plugin root, so the target path has to be carried explicitly.
export const TARGET_PATH_ENV = 'TREEHOUSE_TARGET_PATH'

export type Environment = Record<string, string | undefined>

export type InvocationContext = {
  // Raw payload, kept for logging: the plugin log is how an unexpected shape
  // gets noticed (`herdr plugin log list --plugin treehouse`).
  raw?: string
  workspaceCwd?: string
  focusedPaneCwd?: string
  focusedPaneId?: string
  clickedUrl?: string
}

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
    if (typeof candidate === 'object' && candidate !== null) parsed = candidate as Record<string, unknown>
  } catch {
    // Keep the raw payload for the log and treat the fields as absent; a
    // malformed context must not take the whole invocation down.
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

export type TargetPathInput = {
  // An explicit --repo / --path always wins.
  explicit?: string
  // 'pane' for anything about the focused worktree (teardown, a clicked link),
  // 'workspace' for anything about the repo as a whole.
  prefer: 'pane' | 'workspace'
  env: Environment
}

// Precedence: explicit flag, then the env convention the popup shims use, then
// the plugin invocation context. Undefined means nothing said, which is a
// caller's decision to make: `up` refuses (the plugin repo must never become the
// target), a plain shell invocation falls back to cwd.
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

// The caller's own pane/tab, so teardown can skip itself in a busy check and
// close its own tab last.
export const callerPaneId = (env: Environment) => env.HERDR_PANE_ID
export const callerTabId = (env: Environment) => env.HERDR_TAB_ID

import { describe, expect, test } from 'bun:test'
import {
  TARGET_PATH_ENV,
  invocationTargetPath,
  isPluginInvocation,
  readInvocationContext,
  readWorktreeCreatedEvent,
  requireInvocationTarget,
  type Environment,
} from './context.ts'

const contextEnv = (context: Record<string, unknown>, extra: Record<string, string> = {}) => ({
  HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
  ...extra,
})

describe('readInvocationContext', () => {
  test('reads the cwd fields Herdr sends', () => {
    const context = readInvocationContext(
      contextEnv({
        workspace_cwd: '/dev/repo',
        focused_pane_cwd: '/dev/repo-abc-1',
        focused_pane_id: 'wA:p3',
      }),
    )
    expect(context.workspaceCwd).toBe('/dev/repo')
    expect(context.focusedPaneCwd).toBe('/dev/repo-abc-1')
    expect(context.focusedPaneId).toBe('wA:p3')
  })

  test('keeps the raw payload for the plugin log', () => {
    const context = readInvocationContext(contextEnv({ workspace_cwd: '/dev/repo' }))
    expect(context.raw).toBe('{"workspace_cwd":"/dev/repo"}')
  })

  test('a malformed payload yields no fields instead of throwing', () => {
    const context = readInvocationContext({ HERDR_PLUGIN_CONTEXT_JSON: 'not json' })
    expect(context.raw).toBe('not json')
    expect(context.workspaceCwd).toBeUndefined()
  })

  test('empty strings count as absent', () => {
    expect(readInvocationContext(contextEnv({ workspace_cwd: '' })).workspaceCwd).toBeUndefined()
  })

  test('the clicked url comes from the env, falling back to the context', () => {
    expect(
      readInvocationContext(contextEnv({ clicked_url: 'from-context' }, { HERDR_PLUGIN_CLICKED_URL: 'from-env' }))
        .clickedUrl,
    ).toBe('from-env')
    expect(readInvocationContext(contextEnv({ clicked_url: 'from-context' })).clickedUrl).toBe('from-context')
  })
})

describe('readWorktreeCreatedEvent', () => {
  const eventEnv = (payload: unknown) => ({ HERDR_PLUGIN_EVENT_JSON: JSON.stringify(payload) })

  // The shape herdr 0.7.5 actually sends, confirmed live in the plugin log.
  const liveShape = {
    event: 'worktree_created',
    data: {
      type: 'worktree_created',
      workspace: { workspace_id: 'wD' },
      worktree: { path: '/dev/repo-hook', branch: 'ABC-1/fix', is_linked_worktree: true },
    },
  }

  test('reads the path and branch Herdr sends', () => {
    const event = readWorktreeCreatedEvent(eventEnv(liveShape))
    expect(event.path).toBe('/dev/repo-hook')
    expect(event.branch).toBe('ABC-1/fix')
  })

  test('keeps the raw payload for the plugin log', () => {
    expect(readWorktreeCreatedEvent(eventEnv(liveShape)).raw).toBe(JSON.stringify(liveShape))
  })

  test('a malformed payload yields no fields instead of throwing', () => {
    const event = readWorktreeCreatedEvent({ HERDR_PLUGIN_EVENT_JSON: 'not json' })
    expect(event.raw).toBe('not json')
    expect(event.path).toBeUndefined()
    expect(event.branch).toBeUndefined()
  })

  test('JSON that is not the expected shape yields no fields', () => {
    expect(readWorktreeCreatedEvent(eventEnv('a string')).path).toBeUndefined()
    expect(readWorktreeCreatedEvent(eventEnv(null)).path).toBeUndefined()
    expect(readWorktreeCreatedEvent(eventEnv({ data: { worktree: 'not an object' } })).path).toBeUndefined()
    expect(readWorktreeCreatedEvent(eventEnv({ data: { worktree: { path: 42 } } })).path).toBeUndefined()
  })

  test('no payload at all is empty, raw included', () => {
    expect(readWorktreeCreatedEvent({})).toEqual({})
  })
})

describe('isPluginInvocation', () => {
  test('is true exactly when Herdr injected a context', () => {
    expect(isPluginInvocation(contextEnv({}))).toBe(true)
    expect(isPluginInvocation({})).toBe(false)
  })
})

describe('invocationTargetPath precedence', () => {
  const env = contextEnv(
    { workspace_cwd: '/dev/repo', focused_pane_cwd: '/dev/repo-abc-1' },
    { [TARGET_PATH_ENV]: '/dev/from-env' },
  )

  test('an explicit flag wins over the env and the context', () => {
    expect(invocationTargetPath({ explicit: '/dev/explicit', prefer: 'pane', env })).toBe('/dev/explicit')
  })

  test('the env convention wins over the context', () => {
    expect(invocationTargetPath({ prefer: 'pane', env })).toBe('/dev/from-env')
  })

  test('prefer: pane takes the focused pane, prefer: workspace takes the workspace', () => {
    const withoutEnv = contextEnv({ workspace_cwd: '/dev/repo', focused_pane_cwd: '/dev/repo-abc-1' })
    expect(invocationTargetPath({ prefer: 'pane', env: withoutEnv })).toBe('/dev/repo-abc-1')
    expect(invocationTargetPath({ prefer: 'workspace', env: withoutEnv })).toBe('/dev/repo')
  })

  test('each preference falls back to the other field', () => {
    expect(invocationTargetPath({ prefer: 'pane', env: contextEnv({ workspace_cwd: '/dev/repo' }) })).toBe('/dev/repo')
    expect(
      invocationTargetPath({ prefer: 'workspace', env: contextEnv({ focused_pane_cwd: '/dev/wt' }) }),
    ).toBe('/dev/wt')
  })

  test('a context with no cwd at all resolves to nothing, so callers can refuse', () => {
    expect(invocationTargetPath({ prefer: 'pane', env: contextEnv({ invocation_source: 'keybinding' }) })).toBeUndefined()
    expect(invocationTargetPath({ prefer: 'pane', env: {} })).toBeUndefined()
  })
})

describe('requireInvocationTarget', () => {
  const target = (env: Environment, explicit?: string) =>
    requireInvocationTarget({ explicit, prefer: 'pane', env, cwd: '/dev/cwd' })

  test('a hand-run command falls back to cwd', () => {
    expect(target({})).toBe('/dev/cwd')
  })

  test('anything the invocation named wins over cwd', () => {
    expect(target({}, '/dev/explicit')).toBe('/dev/explicit')
    expect(target({ [TARGET_PATH_ENV]: '/dev/from-env' })).toBe('/dev/from-env')
    expect(target(contextEnv({ focused_pane_cwd: '/dev/wt' }))).toBe('/dev/wt')
  })

  test('a plugin invocation with no cwd refuses rather than naming the plugin repo', () => {
    // cwd is the plugin's own root there, so `up` would bootstrap a worktree of
    // treehouse and `down` would inspect it.
    expect(() => target(contextEnv({ invocation_source: 'keybinding' }))).toThrow(
      /^plugin invocation: could not derive the target repo/,
    )
  })

  test('a clicked link with no context payload refuses as a link invocation', () => {
    // The url arrives through its own variable, so there is no payload to read a
    // cwd from and the plugin check alone would miss it.
    expect(() => target({ HERDR_PLUGIN_CLICKED_URL: 'https://example.atlassian.net/browse/ABC-1' })).toThrow(
      /^link invocation: could not derive the target repo/,
    )
  })

  test('an explicit path is still honoured for a plugin invocation', () => {
    expect(target(contextEnv({ invocation_source: 'keybinding' }), '/dev/explicit')).toBe('/dev/explicit')
  })
})

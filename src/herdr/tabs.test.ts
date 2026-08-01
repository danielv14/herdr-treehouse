import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expectRejection } from '../testing/expectRejection.ts'
import { createFakeHerdr, type FakeResponse, type FakeResponses } from '../testing/fakeHerdr.ts'
import { createTabChoreography, pluginConfigDir } from './tabs.ts'

const TAB_CREATED = { tab: { tab_id: 'wA:t7' }, root_pane: { pane_id: 'wA:p9' } }

const paneSplit = (paneId: string) => ({ pane: { pane_id: paneId } })

const choreography = (responses: FakeResponses, sleeps: number[] = []) => {
  const fake = createFakeHerdr(responses)
  const tabs = createTabChoreography(fake.invoke, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { fake, tabs }
}

describe('workspace lookup', () => {
  test('one lookup answers both callers, reading the id off the response', () => {
    const { tabs } = choreography({
      'worktree list': { source: { source_workspace_id: 'wA' } },
    })
    expect(tabs.findWorkspace('/dev/repo')).toBe('wA')
    expect(tabs.resolveWorkspace('/dev/repo')).toBe('wA')
  })

  test('a repo with no workspace is undefined for find, created for resolve', () => {
    const { fake, tabs } = choreography({
      'worktree list': {},
      'workspace create': { workspace: { workspace_id: 'wB' } },
    })
    expect(tabs.findWorkspace('/dev/repo')).toBeUndefined()
    expect(tabs.resolveWorkspace('/dev/repo')).toBe('wB')
    expect(fake.commands()).toContain('workspace create --cwd /dev/repo --no-focus')
  })

  test('a missing workspace id is "no workspace"; a failed lookup is an error', () => {
    // Herdr answers a repo it does not know with a successful response that has
    // no source_workspace_id. A thrown error means something else went wrong,
    // and teardown must not read that as "no workspace, go ahead".
    const { tabs } = choreography({ 'worktree list': { source: {} } })
    expect(tabs.findWorkspace('/dev/repo')).toBeUndefined()

    const failing = createFakeHerdr({ 'workspace create': { workspace: { workspace_id: 'wB' } } })
    const failingTabs = createTabChoreography(failing.invoke)
    expect(() => failingTabs.findWorkspace('/dev/repo')).toThrow('no response scripted')
    // Opening a tab can still recover by creating the workspace.
    expect(failingTabs.resolveWorkspace('/dev/repo')).toBe('wB')
  })
})

describe('openWorktreeTab', () => {
  const openTwoPanes = async () => {
    const { fake, tabs } = choreography({
      'tab create': TAB_CREATED,
      'pane split': [paneSplit('wA:p10'), paneSplit('wA:p11')],
      'pane rename': {},
      'pane run': {},
      'pane send-text': {},
    })
    const opened = await tabs.openWorktreeTab({
      workspaceId: 'wA',
      cwd: '/dev/repo-abc-1',
      label: 'abc-1',
      focus: false,
      panes: [
        { split: 'right', ratio: 0.5, label: 'shell', autostart: false },
        { split: 'down', ratio: 0.3, label: 'dev', command: 'npm run dev', autostart: false },
      ],
    })
    return { fake, opened }
  }

  test('each pane splits the previous one, the first splits the main pane', async () => {
    const { fake } = await openTwoPanes()
    expect(fake.callsMatching('pane split').map((call) => call.join(' '))).toEqual([
      'pane split wA:p9 --direction right --ratio 0.5 --cwd /dev/repo-abc-1 --no-focus',
      'pane split wA:p10 --direction down --ratio 0.3 --cwd /dev/repo-abc-1 --no-focus',
    ])
  })

  test('pane ids come from the responses and are reported back', async () => {
    const { opened } = await openTwoPanes()
    expect(opened.tabId).toBe('wA:t7')
    expect(opened.mainPaneId).toBe('wA:p9')
    expect(opened.panes.map((pane) => pane.paneId)).toEqual(['wA:p10', 'wA:p11'])
    expect(opened.panes[1].started).toBe(false)
  })

  test('autostart = false pre-fills the command without submitting it', async () => {
    const { fake } = await openTwoPanes()
    expect(fake.commands()).toContain('pane send-text wA:p11 npm run dev')
    expect(fake.callsMatching('pane run')).toHaveLength(0)
  })

  test('autostart = true runs the command', async () => {
    const { fake, tabs } = choreography({
      'tab create': TAB_CREATED,
      'pane split': paneSplit('wA:p10'),
      'pane run': {},
    })
    const opened = await tabs.openWorktreeTab({
      workspaceId: 'wA',
      cwd: '/wt',
      label: 'l',
      focus: true,
      panes: [{ split: 'down', ratio: 0.5, command: 'docker compose up', autostart: true }],
    })
    expect(fake.commands()).toContain('pane run wA:p10 docker compose up')
    expect(fake.callsMatching('pane send-text')).toHaveLength(0)
    expect(opened.panes[0].started).toBe(true)
  })

  test('--focus is passed through as focus or no-focus', async () => {
    const { fake, tabs } = choreography({ 'tab create': TAB_CREATED })
    await tabs.openWorktreeTab({ workspaceId: 'wA', cwd: '/wt', label: 'l', focus: true, panes: [] })
    expect(fake.commands()[0]).toBe('tab create --workspace wA --cwd /wt --label l --focus')
  })

  test('the agent starts in the main pane, and a prompt waits for idle before being submitted', async () => {
    const { fake, tabs } = choreography({
      'tab create': TAB_CREATED,
      'pane run': {},
      'agent wait': {},
      'agent prompt': {},
    })
    const opened = await tabs.openWorktreeTab({
      workspaceId: 'wA',
      cwd: '/wt',
      label: 'l',
      focus: false,
      panes: [],
      agent: 'claude',
      prompt: 'solve ABC-1',
    })
    expect(fake.commands().slice(1)).toEqual([
      'pane run wA:p9 claude',
      'agent wait wA:p9 --until idle --timeout 60000',
      'agent get wA:p9',
      'agent prompt wA:p9 solve ABC-1 --wait --until working --timeout 10000',
    ])
    expect(opened.agentStarted).toBe(true)
  })

  test('a prompt retries while Herdr has not registered the agent yet', async () => {
    // `pane run` starts the process, but `agent wait` 404s until detection has
    // seen it, so the first attempts fail with agent_not_found.
    let attempts = 0
    const sleeps: number[] = []
    let clock = 0
    const fake = createFakeHerdr({
      'tab create': TAB_CREATED,
      'pane run': {},
      'agent wait': () => {
        attempts += 1
        if (attempts < 3) throw new Error('herdr agent wait failed: {"error":{"code":"agent_not_found"}}')
        return {}
      },
      'agent prompt': {},
    })
    const tabs = createTabChoreography(fake.invoke, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })
    await tabs.openWorktreeTab({
      workspaceId: 'wA',
      cwd: '/wt',
      label: 'l',
      focus: false,
      panes: [],
      agent: 'claude',
      prompt: 'go',
    })
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([500, 500])
    expect(fake.commands()).toContain('agent prompt wA:p9 go --wait --until working --timeout 10000')
  })

  test('a prompt gives up if no agent ever registers', async () => {
    let clock = 0
    const fake = createFakeHerdr({
      'tab create': TAB_CREATED,
      'pane run': {},
      'agent wait': () => {
        throw new Error('herdr agent wait failed: {"error":{"code":"agent_not_found"}}')
      },
    })
    const tabs = createTabChoreography(fake.invoke, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    await expectRejection(
      tabs.openWorktreeTab({
        workspaceId: 'wA',
        cwd: '/wt',
        label: 'l',
        focus: false,
        panes: [],
        agent: 'claude',
        prompt: 'go',
      }),
      'no agent registered in wA:p9 within 60000ms',
    )
  })

  test('any other agent wait failure is not retried', async () => {
    const fake = createFakeHerdr({
      'tab create': TAB_CREATED,
      'pane run': {},
      'agent wait': () => {
        throw new Error('herdr agent wait failed: {"error":{"code":"timeout"}}')
      },
    })
    const tabs = createTabChoreography(fake.invoke, { sleep: async () => {} })
    await expectRejection(
      tabs.openWorktreeTab({
        workspaceId: 'wA',
        cwd: '/wt',
        label: 'l',
        focus: false,
        panes: [],
        agent: 'claude',
        prompt: 'go',
      }),
      '"code":"timeout"',
    )
    expect(fake.callsMatching('agent wait')).toHaveLength(1)
  })

  test('no agent means no pane run and no prompt', async () => {
    const { fake, tabs } = choreography({ 'tab create': TAB_CREATED })
    const opened = await tabs.openWorktreeTab({
      workspaceId: 'wA',
      cwd: '/wt',
      label: 'l',
      focus: false,
      panes: [],
      prompt: 'ignored without an agent',
    })
    expect(fake.commands()).toEqual(['tab create --workspace wA --cwd /wt --label l --no-focus'])
    expect(opened.agentStarted).toBe(false)
  })

  test('a response without the ids says which call it was', async () => {
    const { tabs } = choreography({ 'tab create': { tab: {} } })
    await expectRejection(
      tabs.openWorktreeTab({ workspaceId: 'wA', cwd: '/wt', label: 'l', focus: false, panes: [] }),
      'herdr tab create: response has no tab.tab_id',
    )
  })
})

describe('listPanes', () => {
  test('decodes every pane in the workspace, tolerating absent fields', () => {
    const { fake, tabs } = choreography({
      'pane list': {
        panes: [
          { pane_id: 'wA:p1', tab_id: 'wA:t1', cwd: '/dev/repo-abc-1', agent: 'claude', agent_status: 'idle' },
          { pane_id: 'wA:p2', tab_id: 'wA:t1' },
        ],
      },
    })
    expect(tabs.listPanes('wA')).toEqual([
      { paneId: 'wA:p1', tabId: 'wA:t1', cwd: '/dev/repo-abc-1', agent: 'claude', agentStatus: 'idle' },
      { paneId: 'wA:p2', tabId: 'wA:t1', cwd: undefined, agent: undefined, agentStatus: undefined },
    ])
    expect(fake.commands()).toEqual(['pane list --workspace wA'])
  })
})

describe('reportWorkspaceMetadata', () => {
  test('reports every token with the plugin as source, a seq and a ttl', () => {
    const fake = createFakeHerdr({ 'workspace report-metadata': {} })
    const tabs = createTabChoreography(fake.invoke, { now: () => 1234 })
    tabs.reportWorkspaceMetadata({ workspaceId: 'wA', tokens: { worktrees: '3' } })
    expect(fake.commands()).toEqual([
      'workspace report-metadata wA --source treehouse --token worktrees=3 --seq 1234 --ttl-ms 86400000',
    ])
  })
})

describe('inspectWorktreeTab', () => {
  const panes = {
    panes: [
      { pane_id: 'p1', tab_id: 't1', cwd: '/wt' },
      { pane_id: 'p2', tab_id: 't1', cwd: '/wt/services/web' },
      { pane_id: 'p3', tab_id: 't2', cwd: '/elsewhere' },
    ],
  }

  test('only panes inside the worktree count, and their tabs are deduped', async () => {
    const { tabs } = choreography({
      'pane list': panes,
      'pane process-info': { process_info: { foreground_processes: [{ name: 'zsh' }] } },
    })
    const inspection = await tabs.inspectWorktreeTab('wA', '/wt')
    expect(inspection.tabIds).toEqual(['t1'])
    expect(inspection.busyPanes).toEqual([])
  })

  test('a process seen twice, 750ms apart, is busy', async () => {
    const sleeps: number[] = []
    const { fake, tabs } = choreography(
      {
        'pane list': { panes: [{ pane_id: 'p1', tab_id: 't1', cwd: '/wt' }] },
        'pane process-info': {
          process_info: { foreground_processes: [{ name: 'node', cmdline: 'npm run dev' }] },
        },
      },
      sleeps,
    )
    const inspection = await tabs.inspectWorktreeTab('wA', '/wt')
    expect(inspection.busyPanes).toEqual([{ paneId: 'p1', command: 'npm run dev' }])
    expect(sleeps).toEqual([750])
    expect(fake.callsMatching('pane process-info')).toHaveLength(2)
  })

  test('a process gone on the second look is not busy (prompt tooling false positive)', async () => {
    const sleeps: number[] = []
    const { fake, tabs } = choreography(
      {
        'pane list': { panes: [{ pane_id: 'p1', tab_id: 't1', cwd: '/wt' }] },
        'pane process-info': [
          { process_info: { foreground_processes: [{ name: 'starship', cmdline: 'starship prompt' }] } },
          { process_info: { foreground_processes: [] } },
        ],
      },
      sleeps,
    )
    const inspection = await tabs.inspectWorktreeTab('wA', '/wt')
    expect(inspection.busyPanes).toEqual([])
    expect(sleeps).toEqual([750])
    expect(fake.callsMatching('pane process-info')).toHaveLength(2)
  })

  test('an idle or done agent is not busy and is never even probed', async () => {
    const { fake, tabs } = choreography({
      'pane list': {
        panes: [
          { pane_id: 'p1', tab_id: 't1', cwd: '/wt', agent: 'claude', agent_status: 'idle' },
          { pane_id: 'p2', tab_id: 't1', cwd: '/wt', agent: 'claude', agent_status: 'done' },
        ],
      },
    })
    const inspection = await tabs.inspectWorktreeTab('wA', '/wt')
    expect(inspection.busyPanes).toEqual([])
    expect(fake.callsMatching('pane process-info')).toHaveLength(0)
  })

  test('a working agent still counts as busy', async () => {
    const { tabs } = choreography({
      'pane list': { panes: [{ pane_id: 'p1', tab_id: 't1', cwd: '/wt', agent: 'claude', agent_status: 'working' }] },
      'pane process-info': { process_info: { foreground_processes: [{ name: 'claude', cmdline: 'claude' }] } },
    })
    const inspection = await tabs.inspectWorktreeTab('wA', '/wt')
    expect(inspection.busyPanes).toEqual([{ paneId: 'p1', command: 'claude' }])
  })

  test('the caller can exclude its own pane', async () => {
    const { fake, tabs } = choreography({
      'pane list': { panes: [{ pane_id: 'p1', tab_id: 't1', cwd: '/wt' }] },
    })
    const inspection = await tabs.inspectWorktreeTab('wA', '/wt', { ignorePaneId: 'p1' })
    expect(inspection.tabIds).toEqual(['t1'])
    expect(fake.callsMatching('pane process-info')).toHaveLength(0)
  })

  test('the busy probe always names an explicit pane, never --current', async () => {
    const { fake, tabs } = choreography({
      'pane list': { panes: [{ pane_id: 'p1', tab_id: 't1', cwd: '/wt' }] },
      'pane process-info': { process_info: { foreground_processes: [] } },
    })
    await tabs.inspectWorktreeTab('wA', '/wt')
    expect(fake.commands()).toContain('pane process-info --pane p1')
    expect(fake.commands().join(' ')).not.toContain('--current')
  })
})

describe('closeTabs', () => {
  test('closes in order, the caller\'s own tab last', () => {
    const closed: string[] = []
    const { fake, tabs } = choreography({ 'tab close': {} })
    tabs.closeTabs(['t1', 't2', 't3'], { lastTabId: 't1', onClosed: (tabId) => closed.push(tabId) })
    expect(fake.commands()).toEqual(['tab close t2', 'tab close t3', 'tab close t1'])
    expect(closed).toEqual(['t2', 't3', 't1'])
  })

  test('without a last tab the order is untouched', () => {
    const { fake, tabs } = choreography({ 'tab close': {} })
    tabs.closeTabs(['t1', 't2'])
    expect(fake.commands()).toEqual(['tab close t1', 'tab close t2'])
  })
})

describe('openPluginPane', () => {
  test('opens the popup entrypoint and passes env through', () => {
    const { fake, tabs } = choreography({ 'plugin pane open': {} })
    tabs.openPluginPane({ entrypoint: 'up-interactive', env: { TREEHOUSE_TARGET_PATH: '/dev/repo' } })
    expect(fake.commands()).toEqual([
      'plugin pane open --plugin treehouse --entrypoint up-interactive --placement popup --focus --env TREEHOUSE_TARGET_PATH=/dev/repo',
    ])
  })
})

describe('prompt delivery', () => {
  // A freshly started agent can report idle while its TUI is still starting, and
  // the submitted prompt is then dropped (live-observed): the tab opens and the
  // task never arrives.
  const openWithPrompt = async (promptResponse: FakeResponse, stateSeq: FakeResponse = { agent: { state_change_seq: 7 } }) => {
    const sleeps: number[] = []
    const fake = createFakeHerdr({
      'tab create': TAB_CREATED,
      'pane run': {},
      'agent wait': {},
      'agent get': stateSeq,
      'agent prompt': promptResponse,
    })
    const tabs = createTabChoreography(fake.invoke, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    const opening = tabs.openWorktreeTab({
      workspaceId: 'wA',
      cwd: '/wt',
      label: 'l',
      focus: false,
      panes: [],
      agent: 'claude',
      prompt: 'solve ABC-1',
    })
    return { fake, sleeps, opening }
  }

  test('a submission the agent never reacted to is retried until it lands', async () => {
    let attempts = 0
    const { fake, sleeps, opening } = await openWithPrompt(() => {
      attempts += 1
      if (attempts < 3) throw new Error('herdr agent prompt failed: {"error":{"code":"agent_prompt_stalled"}}')
      return {}
    })
    await opening
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([1000, 1000])
    expect(fake.callsMatching('agent prompt')).toHaveLength(3)
  })

  test('the same retry happens when the swallowed prompt comes back as a timeout', async () => {
    // Which code Herdr answers with depends on how its internal windows race, so
    // the decision cannot hang on the code.
    let attempts = 0
    const { fake, opening } = await openWithPrompt(() => {
      attempts += 1
      if (attempts < 2) throw new Error('herdr agent prompt failed: {"error":{"code":"timeout"}}')
      return {}
    })
    await opening
    expect(fake.callsMatching('agent prompt')).toHaveLength(2)
  })

  test('a prompt that never lands fails loudly rather than opening a task-less tab', async () => {
    const { fake, opening } = await openWithPrompt(() => {
      throw new Error('herdr agent prompt failed: {"error":{"code":"agent_prompt_stalled"}}')
    })
    await expectRejection(opening, 'could not hand the prompt to the agent in wA:p9')
    expect(fake.callsMatching('agent prompt')).toHaveLength(3)
  })

  test('an agent that moved is left alone, so a delivered prompt is never doubled', async () => {
    // The wait missed the transition, but the agent's state sequence advanced:
    // it did take the prompt, and resubmitting would run the task twice.
    let seq = 7
    const { fake, opening } = await openWithPrompt(
      () => {
        seq += 2
        throw new Error('herdr agent prompt failed: {"error":{"code":"timeout"}}')
      },
      () => ({ agent: { state_change_seq: seq } }),
    )
    await opening
    expect(fake.callsMatching('agent prompt')).toHaveLength(1)
  })
})

describe('pluginConfigDir', () => {
  test('a plugin-invoked process reads the dir Herdr handed it, no Herdr call', () => {
    const fake = createFakeHerdr({})
    expect(pluginConfigDir(fake.invoke, { HERDR_PLUGIN_CONFIG_DIR: '/cfg/treehouse' })).toBe('/cfg/treehouse')
    expect(fake.calls).toHaveLength(0)
  })

  test('a plain shell invocation asks Herdr, expanding ~ in the answer', () => {
    // The branch every plain `treehouse up` runs in production; the env var only
    // exists for plugin-invoked processes (and tests).
    const fake = createFakeHerdr({ 'plugin config-dir': '~/cfg/plugins/treehouse' })
    expect(pluginConfigDir(fake.invoke, {})).toBe(join(homedir(), 'cfg/plugins/treehouse'))
    expect(fake.commands()).toEqual(['plugin config-dir treehouse'])
  })

  test('an empty answer is an error, not an empty config dir', () => {
    const fake = createFakeHerdr({ 'plugin config-dir': '' })
    expect(() => pluginConfigDir(fake.invoke, {})).toThrow('could not resolve config dir')
  })
})

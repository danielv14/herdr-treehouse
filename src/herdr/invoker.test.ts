import { describe, expect, test } from 'bun:test'
import { createTabChoreography, pluginConfigDir } from './tabs.ts'
import { unpackHerdrResponse, type HerdrInvoker, type HerdrSpawn } from './invoker.ts'

// The production side of the seam, which every other test replaces with the
// recording fake. Response shapes here are the ones observed live (herdr 0.7.5);
// agreement between the two adapters is what this file proves, not that Herdr
// still answers this way.

const spawned = (fields: Partial<HerdrSpawn> = {}): HerdrSpawn => ({
  status: 0,
  stdout: '',
  stderr: '',
  ...fields,
})

const unpack = (fields: Partial<HerdrSpawn>, args: string[] = ['tab', 'create']) =>
  unpackHerdrResponse('herdr', args, spawned(fields))

describe('unpacking a response', () => {
  test('the payload of the result envelope is what comes back', () => {
    expect(unpack({ stdout: '{"result":{"tab":{"tab_id":"wA:t7"}},"ok":true}\n' })).toEqual({
      tab: { tab_id: 'wA:t7' },
    })
  })

  test('a string result comes back as that string', () => {
    expect(unpack({ stdout: '{"result":"wA"}' })).toBe('wA')
  })

  test('a bare body is the value, trimmed', () => {
    // `plugin config-dir` answers with a path and no envelope.
    expect(unpack({ stdout: '~/.config/herdr/plugins/config/treehouse\n' })).toBe(
      '~/.config/herdr/plugins/config/treehouse',
    )
  })

  test('output that does not parse falls back to the bare body too', () => {
    expect(unpack({ stdout: '{"result": unterminated' })).toBe('{"result": unterminated')
  })

  test('an envelope without a result is undefined, not an error', () => {
    // The decoders in tabs.ts treat a missing field as "no answer"; unpacking
    // does not second-guess them.
    expect(unpack({ stdout: '{"ok":true}' })).toBeUndefined()
  })

  test('a non-zero exit throws with the call and the stderr it carried', () => {
    expect(() =>
      unpack({ status: 1, stderr: 'error: pane not found\n' }, ['pane', 'list', '--workspace', 'wA']),
    ).toThrow('herdr pane list --workspace wA failed: error: pane not found')
  })

  test('a non-zero exit with nothing on stderr reports stdout instead', () => {
    expect(() => unpack({ status: 2, stdout: '{"error":"agent_not_found"}\n' })).toThrow(
      'herdr tab create failed: {"error":"agent_not_found"}',
    )
  })

  test('a spawn that never started names the binary it tried', () => {
    // The teardown refusal leans on this path: no herdr on PATH must reach the
    // caller as an error, not as "nothing is running here". Spelled out rather
    // than built from the helper, because null streams are the whole point.
    expect(() =>
      unpackHerdrResponse('/opt/herdr/bin/herdr', ['pane', 'process-info'], {
        status: null,
        stdout: null,
        stderr: null,
        error: new Error('spawnSync /opt/herdr/bin/herdr ENOENT'),
      }),
    ).toThrow('failed to spawn /opt/herdr/bin/herdr: spawnSync /opt/herdr/bin/herdr ENOENT')
  })

  test('a spawn error wins over the exit status', () => {
    expect(() =>
      unpack({ status: null, stdout: null, stderr: null, error: new Error('EACCES') }),
    ).toThrow('failed to spawn herdr')
  })
})

describe('the shape tabs.ts decodes against', () => {
  // Unpacking defines the shape the choreography reads, so the two are checked
  // together: stdout in, decoded value out, no fake in between.
  const invokerOverStdout = (stdout: Record<string, string>): HerdrInvoker => {
    return (args) => {
      const line = args.join(' ')
      const key = Object.keys(stdout).find((prefix) => line === prefix || line.startsWith(`${prefix} `))
      if (key === undefined) throw new Error(`no stdout scripted for "${line}"`)
      return unpackHerdrResponse('herdr', args, spawned({ stdout: stdout[key] }))
    }
  }

  test('a workspace id read off a real envelope', () => {
    const invoke = invokerOverStdout({
      'worktree list': '{"result":{"source":{"source_workspace_id":"wA"}}}\n',
    })
    expect(createTabChoreography(invoke).findWorkspace('/dev/repo')).toBe('wA')
  })

  test('a workspace created for a repo that had none', () => {
    const invoke = invokerOverStdout({
      'worktree list': '{"result":{"source":{}}}\n',
      'workspace create': '{"result":{"workspace":{"workspace_id":"wB"}}}\n',
    })
    expect(createTabChoreography(invoke).resolveWorkspace('/dev/repo')).toBe('wB')
  })

  test('a tab, its root pane and a split pane read off real envelopes', async () => {
    const invoke = invokerOverStdout({
      'tab create': '{"result":{"tab":{"tab_id":"wA:t7"},"root_pane":{"pane_id":"wA:p9"}}}\n',
      'pane split': '{"result":{"pane":{"pane_id":"wA:pA"}}}\n',
      'pane rename': '{"result":{}}\n',
      'pane send-text': '{"result":{}}\n',
    })
    const opened = await createTabChoreography(invoke).openWorktreeTab({
      workspaceId: 'wA',
      cwd: '/dev/repo-abc-1',
      label: '🌳 abc-1',
      focus: false,
      panes: [{ split: 'down', ratio: 0.3, label: 'dev', command: 'npm run dev', autostart: false }],
    })
    expect(opened).toMatchObject({
      tabId: 'wA:t7',
      mainPaneId: 'wA:p9',
      agentStarted: false,
      panes: [{ paneId: 'wA:pA', label: 'dev', command: 'npm run dev', started: false }],
    })
  })

  test('a pane snapshot read off a real envelope', () => {
    const invoke = invokerOverStdout({
      'pane list':
        '{"result":{"panes":[{"pane_id":"wA:p5","tab_id":"wA:t7","cwd":"/dev/repo-abc-1","agent":"claude","agent_status":"idle"}]}}\n',
    })
    expect(createTabChoreography(invoke).listPanes('wA')).toEqual([
      { paneId: 'wA:p5', tabId: 'wA:t7', cwd: '/dev/repo-abc-1', agent: 'claude', agentStatus: 'idle' },
    ])
  })

  test('a busy pane read off a real envelope', async () => {
    // The two shapes `down` refuses on, and the reason #57 exists: its own test
    // provokes the failure through the fake, so nothing else pins these.
    const invoke = invokerOverStdout({
      'pane list': '{"result":{"panes":[{"pane_id":"wA:p5","tab_id":"wA:t7","cwd":"/dev/repo-abc-1"}]}}\n',
      'pane process-info':
        '{"result":{"process_info":{"foreground_processes":[{"name":"node","cmdline":"npm run dev"}]}}}\n',
    })
    const inspected = await createTabChoreography(invoke, { sleep: async () => {} }).inspectWorktreeTab(
      'wA',
      '/dev/repo-abc-1',
    )
    expect(inspected).toEqual({
      tabIds: ['wA:t7'],
      busyPanes: [{ paneId: 'wA:p5', command: 'npm run dev' }],
    })
  })

  test('a bare body is what the config dir lookup expects', () => {
    const invoke = invokerOverStdout({
      'plugin config-dir': '/Users/someone/.config/herdr/plugins/config/treehouse\n',
    })
    expect(pluginConfigDir(invoke, {})).toBe('/Users/someone/.config/herdr/plugins/config/treehouse')
  })
})

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { POPUP_ENTRYPOINTS } from './commands/action.ts'
import { parseFlags } from './cli.ts'
import { findCommand } from './commands/registry.ts'
import { PLUGIN_ID } from './herdr/tabs.ts'

// The manifest and the engine hold the same knowledge on both sides: Herdr
// routes by the manifest while the engine answers by its own declarations. This
// file pins the two together the way branch.test.ts pins the link handler
// patterns, so renaming a pane id, a command or a flag on one side goes red
// instead of breaking the keybindings or the worktree.created hook at runtime.

type ManifestEntry = { id?: unknown; command?: unknown; action?: unknown }
type Manifest = {
  id?: unknown
  actions?: ManifestEntry[]
  panes?: ManifestEntry[]
  events?: ManifestEntry[]
  startup?: ManifestEntry[]
  link_handlers?: ManifestEntry[]
}

const readManifest = async (): Promise<Manifest> =>
  Bun.TOML.parse(
    await Bun.file(join(import.meta.dir, '..', 'herdr-plugin.toml')).text(),
  ) as Manifest

const argvOf = (entry: ManifestEntry): string[] => {
  expect(Array.isArray(entry.command)).toBe(true)
  return (entry.command as unknown[]).map(String)
}

const engineArgv = (entry: ManifestEntry): string[] => {
  const argv = argvOf(entry)
  expect(argv.slice(0, 2)).toEqual(['bash', 'bin/treehouse'])
  return argv.slice(2)
}

describe('the manifest and the engine agree', () => {
  test('the manifest id is the id the engine names itself to Herdr with', async () => {
    expect((await readManifest()).id).toBe(PLUGIN_ID)
  })

  test('every command entry routes through the registry and its flag parser', async () => {
    const manifest = await readManifest()
    const entries = [
      ...(manifest.actions ?? []),
      ...(manifest.panes ?? []),
      ...(manifest.events ?? []),
      ...(manifest.startup ?? []),
    ]
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      const [name, ...rest] = engineArgv(entry)
      const command = findCommand(name)
      expect(command?.name).toBe(name)
      // `action` takes its target as a positional, pinned separately below.
      if (name === 'action') continue
      expect(() => parseFlags(command!, rest)).not.toThrow()
    }
  })

  test('the action entries name actions the engine accepts', async () => {
    const actionArgvs = (await readManifest()).actions
      ?.map(engineArgv)
      .filter((argv) => argv[0] === 'action')
    expect(actionArgvs?.length).toBe(2)
    for (const argv of actionArgvs ?? []) {
      expect(Object.keys(POPUP_ENTRYPOINTS)).toContain(argv[1])
    }
  })

  test('the popup panes the engine opens exist as manifest panes, and vice versa', async () => {
    const declared = ((await readManifest()).panes ?? []).map((pane) => pane.id).sort()
    const opened = Object.values(POPUP_ENTRYPOINTS)
      .map((popup) => popup.entrypoint)
      .sort()
    expect(declared).toEqual(opened)
  })

  test('every link handler routes to an action the manifest declares', async () => {
    const manifest = await readManifest()
    const actionIds = (manifest.actions ?? []).map((action) => action.id)
    for (const handler of manifest.link_handlers ?? []) {
      expect(actionIds).toContain(handler.action)
    }
  })
})

# herdr-treehouse

Herdr plugin for a worktree-as-tab workflow: point it at a branch (or a Jira/GitHub link) and it bootstraps a git worktree according to per-repo config, opens it as a new tab in the repo's Herdr workspace, sets up the repo's pane layout, and starts a coding agent.

The mental model: **a workspace is a repo, a tab is a worktree**. Work happens in parallel across tabs; verification is serial, so a dev pane pre-fills its command (`npm run dev`, `docker compose up`, ...) without running it (`autostart = false`). Press Enter when it is that tab's turn.

## Layout

```
herdr-plugin.toml   manifest: actions, popup pane, link handlers, worktree.created hook
bin/treehouse          stable engine entrypoint (bash shim -> bun)
src/                the engine: up | down | onboard
config.example.toml per-repo config reference
```

The engine is deliberately a plain CLI. The plugin manifest is just one of its call sites; Claude skills, lazygit custom commands, and keybindings call the same `bin/treehouse`.

## Install

```bash
bun install                      # dev types only, engine has no runtime deps
herdr plugin link ~/dev-personal/herdr-treehouse
mkdir -p "$(herdr plugin config-dir treehouse)"
cp config.example.toml "$(herdr plugin config-dir treehouse)/config.toml"   # then edit
```

Requires bun on PATH and Herdr >= 0.7.

## Usage

```bash
treehouse up --branch ABC-1234/fix-thing --target services/web
treehouse up --branch ABC-1234/fix-thing --prompt "Solve ABC-1234 as described in the ticket"
treehouse up --interactive          # used by the popup action (keybinding)
treehouse down                      # from inside a worktree; refuses if dirty or panes are busy
treehouse down --path ../my-awesome-repo-abc-1234
treehouse onboard                   # propose config for the current repo
treehouse onboard --apply           # append it to the plugin config
```

`down` removes the worktree and closes its tab, but never kills running processes and never uses `git worktree remove --force`; it tells you what is in the way instead.

### Where a repo's config lives

Two homes, same fields:

- **Central**: a `[repos.X]` block in `$(herdr plugin config-dir treehouse)/config.toml`. Nothing enters the repo, which is what you want for repos you don't own.
- **Repo-local**: `<repo>/.treehouse.toml`, the same fields without the `[repos.X]` wrapper and without `root` (the file's location is the repo root). Works with or without a central entry, and whether or not you commit it.

Layering is `[defaults]` → `[repos.X]` → `.treehouse.toml`, last one wins, so a repo-local file can also refine a central entry rather than replace it. `treehouse onboard --local` generates the repo-local shape.

### Agent command

The command that starts the agent in the main pane resolves in this order, first match wins:

1. `treehouse up --agent "<cmd>"`
2. `agent` in the repo's `.treehouse.toml`
3. `agent` in the repo's `[repos.X]` block in `config.toml`
4. `agent` in the `[defaults]` block in `config.toml`, which applies to every repo
5. bare `claude`

Left unset, a bare `claude` inherits your own Claude Code settings, so permission mode stays one decision in `~/.claude/settings.json`. Set `[defaults]` instead when you want flags in every worktree tab, including ones with no settings.json equivalent such as `--allow-dangerously-skip-permissions`. A per-repo `agent` is for repos that genuinely deserve different treatment, not for restating something global.

### Keybinding

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "treehouse.up"
description = "treehouse: new worktree tab"

[[keys.command]]
key = "prefix+shift+u"
type = "plugin_action"
command = "treehouse.down"
description = "treehouse: tear down worktree tab"
```

### Link handlers

Ctrl+click a Jira ticket URL (`*.atlassian.net/browse/ABC-1234`) or GitHub issue URL in any pane. Since a click carries no judgment, the engine stays mechanical: it creates an `ABC-1234/wip` branch and opens the tab with a bare agent. What to do about the ticket (explore, fix, just read up) is yours to type; the engine never injects a task prompt on its own. `--prompt` exists for callers (skills) that DO carry that judgment.

## Status / iteration notes

- `worktree.created` hook: reads `HERDR_PLUGIN_EVENT_JSON` per the shape documented by `herdr api schema` (worktree with `path` + `branch`); not yet observed live, so it still logs the raw payload (`herdr plugin log list --plugin treehouse`).
- Multiline `--prompt` is safe: `pane run` delivers it as a single paste + one submit (verified against a live agent, herdr 0.7.4).
- Herdr's native worktree flow opens worktrees as workspaces; this plugin intentionally does not use it (tab model instead).
- Claude skills that wrap this engine live in the skills repo: `herdr-worktree`, `herdr-worktree-teardown`, `herdr-repo-onboard`.

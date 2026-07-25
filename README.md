# herdr-workon

Herdr plugin for a worktree-as-tab workflow: point it at a branch (or a Jira/GitHub link) and it bootstraps a git worktree according to per-repo config, opens it as a new tab in the repo's Herdr workspace, sets up the repo's pane layout, and starts a coding agent.

The mental model: **a workspace is a repo, a tab is a worktree**. Work happens in parallel across tabs; verification is serial, so a dev pane pre-fills its command (`npm run dev`, `docker compose up`, ...) without running it (`autostart = false`). Press Enter when it is that tab's turn.

## Layout

```
herdr-plugin.toml   manifest: actions, popup pane, link handlers, worktree.created hook
bin/workon          stable engine entrypoint (bash shim -> bun)
src/                the engine: up | down | onboard
config.example.toml per-repo config reference
```

The engine is deliberately a plain CLI. The plugin manifest is just one of its call sites; Claude skills, lazygit custom commands, and keybindings call the same `bin/workon`.

## Install

```bash
bun install                      # dev types only, engine has no runtime deps
herdr plugin link ~/dev-personal/herdr-workon
mkdir -p "$(herdr plugin config-dir workon)"
cp config.example.toml "$(herdr plugin config-dir workon)/config.toml"   # then edit
```

Requires bun on PATH and Herdr >= 0.7.

## Usage

```bash
workon up --branch ABC-1234/fix-thing --target services/web
workon up --branch ABC-1234/fix-thing --prompt "Solve ABC-1234 as described in the ticket"
workon up --interactive          # used by the popup action (keybinding)
workon down                      # from inside a worktree; refuses if dirty or panes are busy
workon down --path ../my-awesome-repo-abc-1234
workon onboard                   # propose config for the current repo
workon onboard --apply           # append it to the plugin config
```

`down` removes the worktree and closes its tab, but never kills running processes and never uses `git worktree remove --force`; it tells you what is in the way instead.

### Keybinding

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+shift+u"
type = "plugin_action"
command = "workon.up"
description = "workon: new worktree tab"
```

### Link handlers

Ctrl+click a Jira ticket URL (`*.atlassian.net/browse/ABC-1234`) or GitHub issue URL in any pane. Since a click carries no judgment, the engine stays mechanical: it creates an `ABC-1234/wip` branch and opens the tab with a bare agent. What to do about the ticket (explore, fix, just read up) is yours to type; the engine never injects a task prompt on its own. `--prompt` exists for callers (skills) that DO carry that judgment.

## Status / iteration notes

- `worktree.created` hook: logs its context payload (`herdr plugin log list --plugin workon`) and bootstraps when it can find path + branch; payload shape needs verifying against a real event.
- Herdr's native worktree flow opens worktrees as workspaces; this plugin intentionally does not use it (tab model instead).
- Claude skills that wrap this engine live in the skills repo: `herdr-worktree`, `herdr-worktree-teardown`, `herdr-repo-onboard`.

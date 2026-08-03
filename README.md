# herdr-treehouse

Herdr plugin for a worktree-as-tab workflow: point it at a branch and it bootstraps a git worktree according to per-repo config, opens it as a new tab in the repo's Herdr workspace, sets up the repo's pane layout, and starts a coding agent. Any branch name works; ticket-style names (`ABC-1234/fix-thing`) are a convention the engine understands — they get the short worktree paths and tab labels, and a Jira/GitHub link can stand in for typing the branch — not a requirement.

The mental model: **a workspace is a repo, a tab is a worktree**. Work happens in parallel across tabs; verification is serial, so a dev pane pre-fills its command (`npm run dev`, `docker compose up`, ...) without running it (`autostart = false`). Press Enter when it is that tab's turn.

## Table of contents

- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
  - [Worktree overview](#worktree-overview)
  - [Reopening a worktree](#reopening-a-worktree)
  - [Two branches under one ticket](#two-branches-under-one-ticket)
- [Configuration](#configuration)
  - [Where a repo's config lives](#where-a-repos-config-lives)
  - [Agent command](#agent-command)
  - [Standing context for the agent](#standing-context-for-the-agent)
  - [Sidebar token](#sidebar-token)
  - [Keybinding](#keybinding)
  - [Link handlers](#link-handlers)
- [Driving it from Claude Code](#driving-it-from-claude-code)
- [Design docs](#design-docs)

## How it works

```
herdr-plugin.toml   manifest: actions, popup pane, link handlers, worktree.created hook
bin/treehouse       stable engine entrypoint (bash shim -> bun)
config.example.toml per-repo config reference
src/                the engine
  main.ts           dispatch, cli.ts flags/help, deps.ts the dependency seam
  commands/         up | down | ls | onboard | action | bootstrap | report, plus the registry
  worktree/         branch naming, worktree plan, provisioning, agent context, inventory, git
  herdr/            the Herdr seam: invoker, tab/pane choreography, env payloads
  config/           config shape, validation, defaults
```

The engine is deliberately a plain CLI. The plugin manifest is just one of its call sites; Claude skills, lazygit custom commands, and keybindings call the same `bin/treehouse`. That includes the manifest's own actions: `treehouse action up|down` reads Herdr's invocation context and opens the right popup pane, so no manifest entry needs a script of its own.

Herdr's native worktree flow (`herdr worktree open`) opens worktrees as workspaces; this plugin intentionally bypasses it and opens them as tabs.

## Install

```bash
cd /path/to/herdr-treehouse
bun install                      # dev types only, engine has no runtime deps
herdr plugin link .              # takes any path; the repo root is what it needs
mkdir -p "$(herdr plugin config-dir treehouse)"
cp config.example.toml "$(herdr plugin config-dir treehouse)/config.toml"   # then edit
```

`bin/treehouse` resolves its own location (through symlinks too), so it works from anywhere once linked. For `treehouse` as a bare command, symlink it into a directory on your PATH:

```bash
ln -s "$PWD/bin/treehouse" ~/.local/bin/treehouse
```

Requires bun on PATH and Herdr >= 0.7. `bun test` and `bun run typecheck` cover the engine without a Herdr session.

## Usage

```bash
treehouse up --branch fix-flaky-login-test
treehouse up --branch ABC-1234/fix-thing --target services/web
treehouse up --branch ABC-1234/fix-thing --prompt "Solve ABC-1234 as described in the ticket"
treehouse up --interactive          # used by the popup action (keybinding)
treehouse up --branch ABC-1234/fix-thing --setup   # run setup in a worktree that already exists
treehouse down                      # from inside a worktree; refuses if dirty or panes are busy
treehouse down --path ../my-awesome-repo-abc-1234
treehouse ls                        # every worktree across configured repos
treehouse ls --json                 # stable shape for scripting/skills
treehouse onboard                   # propose config for the current repo
treehouse onboard --apply           # append it to the plugin config
```

`down` removes the worktree and closes its tab, but never kills running processes and never uses `git worktree remove --force`; it tells you what is in the way instead.

### Worktree overview

`treehouse ls` prints one row per worktree across every repo in the central config: branch, dirty state, ahead/behind against the repo's base, last commit age, and (inside Herdr) which tab and agent it has. It is read-only and offline: ahead/behind is against the base as last fetched, and nothing is ever fetched or mutated. Repos configured only by a repo-local `.treehouse.toml` do not appear (there is deliberately no registry of them). A worktree whose path does not match the repo's `worktree_dir` convention shows up marked with `*`.

### Reopening a worktree

`up` on a branch whose worktree already exists creates nothing: it opens a tab on the worktree that is there, with the repo's panes and agent. Where that worktree is comes from git, not from `worktree_dir`, so one created by hand or by another tool is found wherever it was put. A branch checked out in the main checkout is refused rather than opened as a tab.

A worktree that exists is not the same as one that was provisioned: made by hand, by another tool, or before the repo had a config, it has no dependencies and no env file, and the engine does not guess from the state of the directory. `treehouse up --setup` is how you say so: it runs the repo's `setup` commands in the existing worktree and then opens the tab as usual. The reasoning is in [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

### Two branches under one ticket

Attacking one ticket from several angles is a normal way to work: two branches, two worktrees, two tabs, two agents, and you keep the winner. `{id}` is the ticket when the branch has one, so `ABC-123/reducer-approach` and `ABC-123/state-machine-approach` both derive `../my-repo-abc-123`. Whichever branch gets a worktree first keeps that path; the next one goes to the full branch slug (`../my-repo-abc-123-state-machine-approach`), and its tab label and `{id}` use that same name, so the path, the label and any `{id}` in a setup or pane command agree about which of the two it is.

`treehouse ls` shows both as ordinary worktrees, and `down` works per worktree. If `worktree_dir` has no room to tell two branches apart (say `../{repo}-{ticket}`), `up` refuses and says which branch holds the path instead of opening a tab on someone else's worktree. Details in [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

## Configuration

`config.example.toml` is the field-by-field reference; the sections below cover the decisions the fields do not explain themselves.

### Where a repo's config lives

Two homes, same fields:

- **Central**: a `[repos.X]` block in `$(herdr plugin config-dir treehouse)/config.toml`. Nothing enters the repo, which is what you want for repos you don't own.
- **Repo-local**: `<repo>/.treehouse.toml`, the same fields without the `[repos.X]` wrapper and without `root` (the file's location is the repo root). Works with or without a central entry, and whether or not you commit it.

Layering is `[defaults]` → `[repos.X]` → `.treehouse.toml`, last one wins, so a repo-local file can also refine a central entry rather than replace it. `treehouse onboard --local` generates the repo-local shape.

This repo carries its own `.treehouse.toml`: `setup = ["bun install"]` so a fresh worktree has `node_modules`, a pre-filled `bun test --watch` pane, and a `context` telling the agent it is in a worktree and that editing `herdr-plugin.toml` needs `herdr plugin link .` again. `worktree_dir`, `base` and `agent` are left to the defaults.

### Agent command

The command that starts the agent in the main pane resolves in this order, first match wins:

1. `treehouse up --agent "<cmd>"`
2. `agent` in the repo's `.treehouse.toml`
3. `agent` in the repo's `[repos.X]` block in `config.toml`
4. `agent` in the `[defaults]` block in `config.toml`, which applies to every repo
5. bare `claude`

Left unset, a bare `claude` inherits your own Claude Code settings, so permission mode stays one decision in `~/.claude/settings.json`. Set `[defaults]` instead when you want flags in every worktree tab, including ones with no settings.json equivalent such as `--dangerously-skip-permissions`. A per-repo `agent` is for repos that genuinely deserve different treatment, not for restating something global.

The command is placeholder-expanded, whether it comes from `--agent` or from config, so `{worktree}`, `{branch}` and the rest are available in it.

### Standing context for the agent

A repo can carry standing instructions for the agent that starts in its worktree tabs: which branch and ticket the tab stands on, which `--target` dirs the bootstrap actually installed for, that the dev pane is pre-filled and must not be started. `--prompt` is the wrong channel for that; it is a task, carrying judgment from whoever asked.

```toml
[repos.some-monorepo]
context = """
You are in a git worktree of some-monorepo: {worktree}, branch {branch}, ticket {ticket}.
Bootstrapped targets: {targets}. node_modules exists only there.
Do not start the dev command. It is pre-filled in its own pane and verification is serial.
"""
agent = 'claude --append-system-prompt "$(cat {context_file})"'
```

`context` is legal in `[defaults]`, in a `[repos.X]` block and in a repo-local `.treehouse.toml`, layered like every other key: a repo's value replaces the default rather than appending to it. It takes the usual placeholders plus `{targets}`, the `--target` list comma-separated. It goes in the config rather than the repo's `CLAUDE.md` because the plugin is a layer above the work code, which is the only option for repos you do not own — and it is delivered as the **system prompt**, not as a first conversation turn, which would read as the task and age out on compaction.

`{context_file}` is available only in the agent command: the engine renders `context`, writes it to a throwaway file outside any repo, and the shell reads it once at agent start. That keeps the delivery mechanism in the `agent` line, where agent-specific knowledge belongs, and nothing here is Claude-specific except the flag you chose. Half-configured is an error rather than silence: `context` with no `{context_file}` to read it is refused, and `{context_file}` with no `context` to put in it is refused (including a `context` that expands to nothing), all checked before the worktree is provisioned. The engine writes no instructions of its own — with `{branch}`, `{ticket}`, `{worktree}` and `{targets}` you say those things in your own words, and there is no generated block to argue with. The engine-side reasoning, including how the two halves layer across `[defaults]` and a repo, is in [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

### Sidebar token

The engine reports one workspace metadata token to Herdr: `worktrees`, the repo's linked-worktree count. A count of zero clears the token, so repos without worktrees show nothing rather than a `0`. It refreshes when `treehouse up`/`down` change the count, when Herdr's own worktree flow fires `worktree.created`/`worktree.removed`, and on server startup (Herdr does not persist reported tokens across restarts).

Styling stays in your own Herdr config; the engine only reports the value. `rows` replaces the defaults, so keep the built-in items you still want (inline styles take strict `#RGB`/`#RRGGBB` foregrounds):

```toml
# ~/.config/herdr/config.toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", { token = "$worktrees", fg = "#89b4fa", dim = true }],
]
```

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

## Driving it from Claude Code

Because the engine is a plain CLI with no interactive requirements, a coding agent can run it for you. Wrapping the commands in Claude Code skills means asking for a worktree in prose instead of assembling flags:

> "start a worktree for ABC-1234, the API and the web app" → `treehouse up --branch ABC-1234/... --target services/api --target apps/web --prompt "..."`

That is worth doing because the flags are exactly the part that needs judgment: which branch name follows your convention, which targets the bootstrap needs, whether the agent should get a task prompt at all, and whether the worktree is safe to tear down. The engine deliberately refuses to guess any of it.

The split to keep if you write your own skills:

- **The skill carries judgment.** Read the ticket, derive the branch, pick the targets, decide the prompt, decide when teardown is appropriate.
- **The engine carries mechanics.** Worktree creation, setup, panes, tabs, teardown safety. Anything a skill teaches itself about those is a second implementation that will drift.
- **Permission posture belongs at a launch site, never in a skill.** Configure `agent` in `[defaults]`, or leave it unset and let your own Claude Code settings decide. A skill that injects `--dangerously-skip-permissions` hides that decision in markdown and makes the skill path behave differently from `treehouse up`.

The three skills used with this plugin day to day are `herdr-worktree`, `herdr-worktree-teardown` and `herdr-repo-onboard`. They are thin by design and live outside this repo.

## Design docs

The reasoning behind the engine's behaviour lives in `docs/`:

- [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md) — placement and naming (one worktree per branch), provisioning, standing agent context, teardown safety
- [`docs/config.md`](docs/config.md) — config resolution, validation policy, TOML footguns
- [`docs/herdr-quirks.md`](docs/herdr-quirks.md) — live-observed Herdr behaviours the engine codes around (agent prompt delivery, busy-pane detection, tab choreography, plugin payloads)

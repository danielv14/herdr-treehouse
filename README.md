# herdr-treehouse

Herdr plugin for a worktree-as-tab workflow: point it at a branch and it bootstraps a git worktree according to per-repo config, opens it as a new tab in the repo's Herdr workspace, sets up the repo's pane layout, and starts a coding agent.

The mental model: **a workspace is a repo, a tab is a worktree**. Work happens in parallel across tabs; verification is serial, so a dev pane pre-fills its command (`npm run dev`, `docker compose up`, ...) without running it. Press Enter when it is that tab's turn.

## Table of contents

- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
  - [Worktree overview](#worktree-overview)
  - [Reopening a worktree](#reopening-a-worktree)
  - [Two branches under one ticket](#two-branches-under-one-ticket)
- [Configuration](#configuration)
  - [Where a repo's config lives](#where-a-repos-config-lives)
  - [Placeholders](#placeholders)
  - [Agent command](#agent-command)
  - [Standing context for the agent](#standing-context-for-the-agent)
  - [Sidebar token](#sidebar-token)
  - [Keybinding](#keybinding)
- [Driving it from Claude Code](#driving-it-from-claude-code)
- [Design docs](#design-docs)

## How it works

Everything is one plain CLI, `bin/treehouse`. The Herdr plugin manifest is just one of its call sites; Claude skills, lazygit custom commands, and keybindings call the same binary. `treehouse up` creates the worktree (or finds the one the branch already has), runs the repo's setup, opens a tab on it, splits the configured panes, and starts the agent in the main pane. `treehouse down` tears all of that down again, safely.

Worktrees live as siblings of the main checkout (`../{repo}-{id}` by default), so `cd ../my-repo-abc-1234` is the whole navigation story. Herdr's own worktree flow (`herdr worktree open`) opens worktrees as workspaces; treehouse intentionally bypasses it and opens them as tabs.

## Install

```bash
cd /path/to/herdr-treehouse
bun install                      # dev types only, no runtime deps
herdr plugin link .              # takes any path; the repo root is what it needs
mkdir -p "$(herdr plugin config-dir treehouse)"
cp config.example.toml "$(herdr plugin config-dir treehouse)/config.toml"   # then edit
```

`bin/treehouse` resolves its own location (through symlinks too), so it works from anywhere once linked. For `treehouse` as a bare command, symlink it into a directory on your PATH:

```bash
ln -s "$PWD/bin/treehouse" ~/.local/bin/treehouse
```

Requires bun on PATH and Herdr >= 0.7. `bun test` and `bun run typecheck` cover the CLI without a Herdr session.

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

Any branch name works. Ticket-style names (`ABC-1234/fix-thing`) get the short worktree path and tab label, and a Jira ticket or GitHub issue URL can be ctrl+clicked in any pane instead of typing the branch: that creates an `ABC-1234/wip` branch and opens the tab with a bare agent. A click carries no task, so what to do about the ticket is yours to type.

`down` removes the worktree and closes its tab, but never kills running processes and never uses `git worktree remove --force`; it tells you what is in the way instead.

### Worktree overview

`treehouse ls` prints one row per worktree across every repo in the central config: branch, dirty state, ahead/behind against the repo's base, last commit age, and (inside Herdr) which tab and agent it has. It is read-only and offline: ahead/behind is against the base as last fetched, and nothing is ever fetched or mutated. Repos configured only by a repo-local `.treehouse.toml` do not appear (there is deliberately no registry of them). A worktree whose path does not match the repo's `worktree_dir` convention shows up marked with `*`.

### Reopening a worktree

`up` on a branch whose worktree already exists creates nothing: it opens a tab on the worktree that is there, with the repo's panes and agent. Where that worktree is comes from git, not from `worktree_dir`, so one created by hand or by another tool is found wherever it was put. A branch checked out in the main checkout is refused rather than opened as a tab.

A worktree that exists is not the same as one that was provisioned: made by hand, by another tool, or before the repo had a config, it has no dependencies and no env file, and treehouse does not guess from the state of the directory. `treehouse up --setup` is how you say so: it runs the repo's `setup` commands in the existing worktree and then opens the tab as usual. The reasoning is in [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

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

### Placeholders

`worktree_dir`, `setup`, `bootstrap`, pane commands, `context` and the agent command are all placeholder-expanded:

| Placeholder | Value |
| --- | --- |
| `{repo}` | repo name (the config key) |
| `{branch}` | full branch name, e.g. `ABC-1234/fix-thing` |
| `{slug}` | slugified branch, e.g. `abc-1234-fix-thing` |
| `{ticket}` | leading ticket id lowercased (`abc-1234`), empty if none |
| `{id}` | `{ticket}` if the branch has one, otherwise `{slug}`; also the tab label. Falls back to `{slug}` when a second branch of the same ticket needs its own worktree |
| `{worktree}` | resolved worktree path |
| `{root}` | main checkout path |
| `{base}` | base ref (default `origin/master`) |
| `{config_dir}` | the plugin config dir, i.e. where `config.toml` and your `bootstraps/` live; not legal in `worktree_dir` |
| `{targets}` | the `--target` list, comma-separated; empty when none were given |
| `{targets...}` | one argv entry per `--target` — bootstrap argv only |
| `{context_file}` | path of the rendered `context` file — agent command only |
| `{model_arg}` | the repo's `model_arg` rendered, empty when no `--model` was given — agent command only |
| `{model}` | the name passed to `--model` — `model_arg` only |

A typo'd placeholder (`{wortkree}`) is an error that stops the run, not a literal that reaches a shell command. Any other brace passes through untouched, since config values are shell commands: `{{.Names}}`, `{print $1}` and `${HOME}` all survive.

`{config_dir}` names a `bootstrap` script kept next to your config without writing Herdr's plugin config path into every entry: `bootstrap = ["{config_dir}/bootstraps/my-repo.sh", ...]`. Why a relative `argv[0]` is not the shorthand it looks like, and which anchor `onboard` proposes for each config home, is in [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

### Agent command

The command that starts the agent in the main pane resolves in this order, first match wins:

1. `treehouse up --agent "<cmd>"`
2. `agent` in the repo's `.treehouse.toml`
3. `agent` in the repo's `[repos.X]` block in `config.toml`
4. `agent` in the `[defaults]` block in `config.toml`, which applies to every repo
5. bare `claude`

Left unset, a bare `claude` inherits your own Claude Code settings, so permission mode stays one decision in `~/.claude/settings.json`. Set `[defaults]` instead when you want flags in every worktree tab, including ones with no settings.json equivalent such as `--dangerously-skip-permissions`. A per-repo `agent` is for repos that genuinely deserve different treatment, not for restating something global.

### A different model for one tab

`--agent` replaces the whole command, so using it to change one word means restating the rest, permission flags included. `model_arg` gives a model its own slot instead:

```toml
[defaults]
model_arg = '--model {model}'
agent = 'claude --dangerously-skip-permissions {model_arg} --append-system-prompt "$(cat {context_file})"'
```

```bash
treehouse up --branch ABC-1234/heavier-thing --model opus
```

Without `--model` the slot expands to nothing and the command is exactly what it was. The flag's spelling lives in `model_arg`, which is why treehouse can offer this without knowing anything about your agent's CLI: it fills a slot you declared. No model name belongs in the config, so nothing needs updating when a new release lands, and an alias your agent resolves itself (`opus`, `fable`) keeps working across them.

Both refusals only apply when `--model` is actually passed: without a `model_arg` there is nowhere to put the value, and without a `{model_arg}` in the agent command the model would be dropped while the tab opened as if nothing were wrong. A `model_arg` nothing uses is fine, unlike a `context` nothing reads — no model was asked for, so nothing is lost.

### Standing context for the agent

A repo can carry standing instructions for the agent that starts in its worktree tabs: which branch and ticket the tab stands on, which `--target` dirs got dependencies, that the dev pane is pre-filled and must not be started. `--prompt` is the wrong channel for that; it is a task, carrying judgment from whoever asked.

```toml
[repos.some-monorepo]
context = """
You are in a git worktree of some-monorepo: {worktree}, branch {branch}, ticket {ticket}.
Bootstrapped targets: {targets}. node_modules exists only there.
Do not start the dev command. It is pre-filled in its own pane and verification is serial.
"""
agent = 'claude --append-system-prompt "$(cat {context_file})"'
```

`context` is legal in `[defaults]`, in a `[repos.X]` block and in a repo-local `.treehouse.toml`, layered like every other key: a repo's value replaces the default rather than appending to it. It goes in the config rather than the repo's `CLAUDE.md` because the plugin is a layer above the work code, which is the only option for repos you do not own — and it is delivered as the **system prompt**, not as a first conversation turn, which would read as the task and age out on compaction.

`{context_file}` is available only in the agent command: treehouse renders `context`, writes it to a throwaway file outside any repo, and the shell reads it once at agent start. Half-configured is an error rather than silence: `context` with no `{context_file}` to read it is refused, and `{context_file}` with no `context` to put in it is refused, all checked before the worktree is provisioned. Treehouse writes no instructions of its own — with `{branch}`, `{ticket}`, `{worktree}` and `{targets}` you say those things in your own words. The reasoning, including how the two halves layer across `[defaults]` and a repo, is in [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

### Sidebar token

treehouse reports one workspace metadata token to Herdr: `worktrees`, the repo's linked-worktree count. A count of zero clears the token, so repos without worktrees show nothing rather than a `0`. It refreshes when `treehouse up`/`down` change the count, when Herdr's own worktree flow fires `worktree.created`/`worktree.removed`, on every workspace focus, and on server startup (Herdr does not persist reported tokens across restarts).

Focus is what covers plain `git worktree add`/`remove`, which fires no Herdr event at all. Every focus re-reports every configured repo, not just the focused one, because the sidebar shows all workspace rows at once. `treehouse report` does the same thing on demand if you want the numbers refreshed without switching workspace.

Styling stays in your own Herdr config; treehouse only reports the value. `rows` replaces the defaults, so keep the built-in items you still want (inline styles take strict `#RGB`/`#RRGGBB` foregrounds):

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

## Driving it from Claude Code

Because treehouse is a plain CLI with no interactive requirements, a coding agent can run it for you. The nicest setup is a small Claude Code skill on top: ask for a worktree in prose ("start a worktree for ABC-1234, the API and the web app") and let the skill read the ticket, derive the branch name, pick the `--target` dirs and decide whether the agent should get a `--prompt`. Those flags are exactly the part that needs judgment, and the CLI deliberately refuses to guess them. Point your agent at this repo and have it write skills tailored to your own workflow — branch conventions, ticket system, teardown habits and all.

One thing to keep out of skills: permission flags like `--dangerously-skip-permissions`. That decision belongs in your `agent` config or your own Claude Code settings, not hidden in a skill's markdown where the skill path behaves differently from a plain `treehouse up`.

## Design docs

The reasoning behind the CLI's behaviour lives in `docs/`:

- [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md) — placement and naming (one worktree per branch), provisioning, standing agent context, teardown safety
- [`docs/config.md`](docs/config.md) — config resolution, validation policy, TOML footguns
- [`docs/herdr-quirks.md`](docs/herdr-quirks.md) — live-observed Herdr behaviours the CLI codes around (agent prompt delivery, busy-pane detection, tab choreography, plugin payloads)

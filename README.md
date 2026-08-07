# herdr-treehouse

Herdr plugin for a worktree-as-tab workflow: point it at a branch and it bootstraps a git worktree according to per-repo config, opens it as a new tab in the repo's Herdr workspace, sets up the repo's pane layout, and starts a coding agent.

The mental model: **a workspace is a repo, a tab is a worktree**. Work happens in parallel across tabs.

## Table of contents

- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
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

`treehouse ls` is a read-only overview of every worktree across the repos in the central config:

```
REPO             BRANCH                  DIRTY    BASE   LAST     TAB               PATH
my-awesome-repo  ABC-1234/fix-thing      2 dirty  +3/-0  12m ago  claude (working)  ../my-awesome-repo-abc-1234
my-awesome-repo  ABC-1234/state-machine  clean    +0/-4  2h ago   open              ../my-awesome-repo-abc-1234-state-machine
side-project     spike-oxc               clean    -      3d ago   -                 ../wt-spike-oxc *

* path does not match the repo's worktree_dir convention
```

Nothing is fetched or changed, so `BASE` is ahead/behind as of the last fetch. `TAB` only appears inside Herdr. Repos configured only by a repo-local `.treehouse.toml` are absent; there is deliberately no registry of them.

`up` on a branch that already has a worktree creates nothing: it opens a tab on the worktree git says the branch is in, wherever that is, and runs no setup — `--setup` is for a worktree that exists but was never provisioned. Two branches of one ticket get one worktree each: the first keeps the ticket path, the second the full branch slug, with its tab label and `{id}` to match. Both cases, and what `up` refuses rather than guessing, are in [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

## Configuration

`config.example.toml` is the field-by-field reference; the sections below cover the decisions the fields do not explain themselves, and `docs/` has the reasoning behind them.

### Where a repo's config lives

Two homes, same fields:

- **Central**: a `[repos.X]` block in `$(herdr plugin config-dir treehouse)/config.toml`. Nothing enters the repo, which is what you want for repos you don't own.
- **Repo-local**: `<repo>/.treehouse.toml`, the same fields without the `[repos.X]` wrapper and without `root` (the file's location is the repo root). Works with or without a central entry, and whether or not you commit it.

Layering is `[defaults]` → `[repos.X]` → `.treehouse.toml`, last one wins, so a repo-local file can also refine a central entry rather than replace it. `treehouse onboard --local` generates the repo-local shape. This repo carries its own `.treehouse.toml` as a working example.

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

`--agent` replaces the whole command, so changing one word means restating the rest, permission flags included. To change the model for one tab, declare how your agent spells the flag and where it goes:

```toml
[defaults]
model_arg = '--model {model}'
agent = 'claude --dangerously-skip-permissions {model_arg} --append-system-prompt "$(cat {context_file})"'
```

```bash
treehouse up --branch ABC-1234/heavier-thing --model opus
```

Without `--model` the slot expands to nothing and the command is exactly what it was. Passing one that has nowhere to go is refused rather than dropped. Why the spelling lives in the config, why no model name does, and why an unused `model_arg` is fine: [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

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

`context` is legal in `[defaults]`, in a `[repos.X]` block and in a repo-local `.treehouse.toml`, layered like every other key, and it arrives as the **system prompt** rather than a first conversation turn. `{context_file}` works only in the agent command: treehouse renders the text to a throwaway file outside any repo, and the shell reads it once at agent start. `up` prints the path of that file in its summary. Configure both halves or neither; one without the other is refused before the worktree is provisioned. Treehouse adds no instructions of its own, and the placeholders are there so you can write them. The reasoning, including how the two halves layer across `[defaults]` and a repo, is in [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

### Sidebar token

treehouse reports one workspace metadata token to Herdr: `worktrees`, the repo's linked-worktree count. A count of zero clears the token, so repos without worktrees show nothing rather than a `0`. Four things refresh it:

| Refresh | Covers |
| --- | --- |
| `treehouse up` / `down`, in-process | our own git-side changes, which Herdr's worktree events do not see |
| `worktree.created` / `worktree.removed` hooks | Herdr's native worktree flow |
| `workspace.focused` hook | plain `git worktree add`/`remove`, which fires no Herdr event at all |
| `[[startup]]` | a server restart (Herdr does not persist reported tokens) |

`treehouse report` does the same on demand. Why focus, and why a focus re-reports every configured repo rather than the focused one: [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md).

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

Because treehouse is a plain CLI with no interactive requirements, a coding agent can run it for you. The nicest setup is a small Claude Code skill on top: ask for a worktree in prose ("start a worktree for ABC-1234, the API and the web app") and let the skill read the ticket, derive the branch name, pick the `--target` dirs and decide whether the agent should get a `--prompt`. Those flags are exactly the part that needs judgment, and the CLI deliberately refuses to guess them. Point your agent at this repo and have it write skills tailored to your own workflow.

One thing to keep out of skills: permission flags like `--dangerously-skip-permissions`. That decision belongs in your `agent` config or your own Claude Code settings, not hidden in a skill's markdown where the skill path behaves differently from a plain `treehouse up`.

## Design docs

The reasoning behind the CLI's behaviour lives in `docs/`:

- [`docs/worktree-lifecycle.md`](docs/worktree-lifecycle.md) — placement and naming (one worktree per branch), provisioning, standing agent context, per-tab model, sidebar count reporting, teardown safety
- [`docs/config.md`](docs/config.md) — config resolution, validation policy, TOML footguns
- [`docs/herdr-quirks.md`](docs/herdr-quirks.md) — live-observed Herdr behaviours the CLI codes around (agent prompt delivery, busy-pane detection, tab choreography, plugin payloads)

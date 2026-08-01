# herdr-treehouse

Herdr plugin for a worktree-as-tab workflow: point it at a branch (or a Jira/GitHub link) and it bootstraps a git worktree according to per-repo config, opens it as a new tab in the repo's Herdr workspace, sets up the repo's pane layout, and starts a coding agent.

The mental model: **a workspace is a repo, a tab is a worktree**. Work happens in parallel across tabs; verification is serial, so a dev pane pre-fills its command (`npm run dev`, `docker compose up`, ...) without running it (`autostart = false`). Press Enter when it is that tab's turn.

## Layout

```
herdr-plugin.toml   manifest: actions, popup pane, link handlers, worktree.created hook
bin/treehouse       stable engine entrypoint (bash shim -> bun)
config.example.toml per-repo config reference
src/                the engine
  main.ts           dispatch, cli.ts flags/help, deps.ts the dependency seam
  commands/         up | down | ls | onboard | action | bootstrap | report, plus the registry
  worktree/         branch naming, worktree plan, provisioning, inventory, git
  herdr/            the Herdr seam: invoker, tab/pane choreography, env payloads
  config/           config shape, validation, defaults
```

The engine is deliberately a plain CLI. The plugin manifest is just one of its call sites; Claude skills, lazygit custom commands, and keybindings call the same `bin/treehouse`. That includes the manifest's own actions: `treehouse action up|down` reads Herdr's invocation context and opens the right popup pane, so no manifest entry needs a script of its own.

## Install

```bash
cd /path/to/herdr-treehouse
bun install                      # dev types only, engine has no runtime deps
herdr plugin link .              # takes any path; the repo root is what it needs
mkdir -p "$(herdr plugin config-dir treehouse)"
cp config.example.toml "$(herdr plugin config-dir treehouse)/config.toml"   # then edit
```

`bin/treehouse` resolves its own location, so it works from anywhere once linked; put it on your PATH (or alias it) if you want `treehouse` as a bare command.

Requires bun on PATH and Herdr >= 0.7. `bun test` and `bun run typecheck` cover the engine without a Herdr session.

## Usage

```bash
treehouse up --branch ABC-1234/fix-thing --target services/web
treehouse up --branch ABC-1234/fix-thing --prompt "Solve ABC-1234 as described in the ticket"
treehouse up --interactive          # used by the popup action (keybinding)
treehouse down                      # from inside a worktree; refuses if dirty or panes are busy
treehouse down --path ../my-awesome-repo-abc-1234
treehouse ls                        # every worktree across configured repos
treehouse ls --json                 # stable shape for scripting/skills
treehouse onboard                   # propose config for the current repo
treehouse onboard --apply           # append it to the plugin config
```

`down` removes the worktree and closes its tab, but never kills running processes and never uses `git worktree remove --force`; it tells you what is in the way instead.

### Worktree overview

`treehouse ls` prints one row per worktree across every repo in the central config: branch, dirty state, ahead/behind against the repo's base, last commit age, and (inside Herdr) which tab and agent it has. It is read-only and offline: ahead/behind is against the base as last fetched, and nothing is ever fetched or mutated. Repos configured only by a repo-local `.treehouse.toml` do not appear (there is deliberately no registry of them). A worktree whose path does not match the repo's `worktree_dir` convention still shows up, marked with `*` (the check is a path comparison against the current branch name, so a branch renamed after creation trips it too).

### Sidebar token

The engine reports one workspace metadata token to Herdr: `worktrees`, the repo's linked-worktree count. A count of zero clears the token, so repos without worktrees show nothing rather than a `0`. It refreshes when `treehouse up`/`down` change the count, when Herdr's own worktree flow fires `worktree.created`/`worktree.removed`, and on server startup (Herdr does not persist reported tokens across restarts). Styling stays in your own Herdr config; the engine only reports the value. `rows` is a list of rows, each row a list of items, and setting it replaces the defaults, so keep the built-in items you still want (inline styles take strict `#RGB`/`#RRGGBB` foregrounds):

```toml
# ~/.config/herdr/config.toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", { token = "$worktrees", fg = "#89b4fa", dim = true }],
]
```

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

### Driving it from Claude Code

Because the engine is a plain CLI with no interactive requirements, a coding agent can run it for you. Wrapping the commands in Claude Code skills means asking for a worktree in prose instead of assembling flags:

> "start a worktree for ABC-1234, the API and the web app" → `treehouse up --branch ABC-1234/... --target services/api --target apps/web --prompt "..."`

That is worth doing because the flags are exactly the part that needs judgment: which branch name follows your convention, which targets the bootstrap needs, whether the agent should get a task prompt at all, and whether the worktree is safe to tear down. The engine deliberately refuses to guess any of it.

The split to keep if you write your own skills:

- **The skill carries judgment.** Read the ticket, derive the branch, pick the targets, decide the prompt, decide when teardown is appropriate.
- **The engine carries mechanics.** Worktree creation, setup, panes, tabs, teardown safety. Anything a skill teaches itself about those is a second implementation that will drift.
- **Permission posture belongs at a launch site, never in a skill.** Configure `agent` in `[defaults]`, or leave it unset and let your own Claude Code settings decide. A skill that injects `--dangerously-skip-permissions` hides that decision in markdown and makes the skill path behave differently from `treehouse up`.

The three skills used with this plugin day to day are `herdr-worktree`, `herdr-worktree-teardown` and `herdr-repo-onboard`. They are thin by design and live outside this repo.

## Status / iteration notes

- `worktree.created` hook: verified live on herdr 0.7.5, payload as documented by `herdr api schema` (worktree with `path` + `branch`). It runs the same provisioning as `treehouse up`, so a repo configured with only `setup` gets its dependencies here too. The raw payload is still logged (`herdr plugin log list --plugin treehouse`).
- `--prompt` is handed to `herdr agent prompt` once the agent reports idle, so multiline prompts and submission are Herdr's business rather than a paste workaround (herdr 0.7.5).
- Herdr's native worktree flow opens worktrees as workspaces; this plugin intentionally does not use it (tab model instead).

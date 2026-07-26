# herdr-treehouse

Herdr plugin + CLI engine for a worktree-as-tab workflow. Mental model: **a Herdr workspace is a repo, a tab is a worktree**. See README.md for install and usage.

## Architecture

Three layers, strictly separated:

1. **Engine** (`src/`, entrypoint `bin/treehouse`): all mechanics. Plain Bun/TypeScript CLI, no runtime deps. The plugin manifest, Claude skills, lazygit commands, and keybindings are all just call sites for this one binary.
2. **Manifest** (`herdr-plugin.toml`): declares how Herdr reaches the engine (actions, popup pane, link handlers, `worktree.created` hook). Actions cannot take free arguments; context arrives via env (`HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_PLUGIN_CLICKED_URL`).
3. **Personal wiring** (NOT in this repo): `$(herdr plugin config-dir treehouse)` = `~/.config/herdr/plugins/config/treehouse/`, holding `config.toml` and `bootstraps/*.sh`. This repo only ships `config.example.toml`. Keep the committed code generic (no employer-specific repo names, ticket prefixes, or Atlassian sites); that separation is deliberate so the repo stays shareable.

## Key decisions (don't undo casually)

- **Worktree = tab, not workspace.** Herdr's native `herdr worktree open` opens worktrees as workspaces; we intentionally bypass it and use `tab create --cwd`.
- **`autostart = false` is the norm.** Dev commands are pre-filled with `pane send-text` (no Enter). Work is parallel across tabs but verification is serial; two tabs must never race for the same docker containers/ports.
- **`down` never forces.** Refuses on uncommitted changes and on panes with confirmed running processes (double snapshot 750ms apart, because prompt tooling spawns short-lived processes that false-positive a single check). Never kills processes, never `git worktree remove --force`, leaves the branch (PR merge cleans it up).
- **Panes config**: `[[repos.X.panes]]` entries each split the PREVIOUS pane; the first splits the main/agent pane. `[{split="right"}, {split="down"}]` gives agent | halved right column.
- **`setup` vs `bootstrap` are two tiers, keep both.** `setup` is a list of plain shell commands run inside a freshly created worktree (skipped when it already existed) — covers most repos (`npm ci`, `cp {root}/.env .env`) without a script. `bootstrap` replaces worktree creation entirely and is for script-grade logic (monorepos). Don't merge them.
- **A repo's config has two legal homes.** A `[repos.X]` block centrally, or `<repo>/.treehouse.toml` (same fields, no wrapper, no `root`), layered `[defaults]` → `[repos.X]` → local. The local file works standalone, so a repo needs no central entry at all. Which home fits is a judgment call about the repo's ownership, which is why `onboard` only exposes `--local` and leaves the choice to the caller.
- **Worktrees are siblings of the main checkout.** `worktree_dir` defaults to `../{repo}-{id}`, and relative paths resolve against the main checkout rather than cwd. Deliberately NOT Claude Code's own `<repo>/.claude/worktrees/` layout: nesting N long-lived worktrees inside the checkout puts copies of the tree in the path of watchers, test globs, build contexts and workspace globs, and needs a per-repo `.gitignore` entry the engine can't guarantee. Sibling also means `cd ../{repo}-{id}` is the whole navigation story.
- **Permission posture belongs at a launch site, never in a skill.** The agent command resolves `--agent` > `.treehouse.toml` > `[repos.X]` > `[defaults]` > bare `claude`. `[defaults].agent` is the home for flags wanted in every worktree tab; bare `claude` instead inherits `permissions.defaultMode` from the user's own Claude Code settings. Both are legitimate, and which one carries the posture is the user's call, not the engine's, so don't "consolidate" a configured `[defaults].agent` into settings.json. A per-repo `agent` is for repos that genuinely deserve different treatment, not for restating a global preference. Skills must never inject permission flags: that hides the decision in markdown and makes the skill path behave differently from `treehouse up`.
- **Related skills** live in `~/dev-personal/skills`: `herdr-worktree`, `herdr-worktree-teardown`, `herdr-repo-onboard` (judgment layers; keep mechanics out of them, in the engine).

## Development

```bash
bun install
bun run typecheck        # tsc --noEmit, no build step (bun runs .ts directly)
herdr plugin link .      # re-run after editing herdr-plugin.toml
herdr plugin log list --plugin treehouse   # event/action stderr logs
```

Herdr CLI responses are JSON; `src/herdr.ts` wraps invocation and returns the parsed `result`. Never construct pane/tab IDs; always read them from responses.

## Status / open ends

- `worktree.created` hook reads `HERDR_PLUGIN_EVENT_JSON` per the shape from `herdr api schema` (authoritative payload reference); not yet observed live, raw payload is logged for confirmation.
- Multiline text through `pane run` arrives as ONE paste + one submit (live-verified, herdr 0.7.4) — no per-line splitting; multiline `--prompt` is safe.
- `down` treats a registered agent in `idle`/`done` as not busy (tearing it down is the point); `working`/`blocked` agents and non-agent processes still refuse.
- `up` currently requires `HERDR_ENV=1`. Planned (pending the owner deciding Herdr is a keeper): degrade gracefully outside Herdr by running bootstrap only and skipping tab/panes/agent.
- Overlap with the `vk-branch` skill's worktree mode is known and intentionally left until that decision. Details in `~/.claude/CLAUDE.md` under "Herdr + treehouse".

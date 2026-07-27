# herdr-treehouse

Herdr plugin + CLI engine for a worktree-as-tab workflow. Mental model: **a Herdr workspace is a repo, a tab is a worktree**. See README.md for install and usage.

## Architecture

Three layers, strictly separated:

1. **Engine** (`src/`, entrypoint `bin/treehouse`): all mechanics. Plain Bun/TypeScript CLI, no runtime deps. The plugin manifest, Claude skills, lazygit commands, and keybindings are all just call sites for this one binary.
2. **Manifest** (`herdr-plugin.toml`): declares how Herdr reaches the engine (actions, popup pane, link handlers, `worktree.created` hook). Actions cannot take free arguments; context arrives via env (`HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_PLUGIN_CLICKED_URL`). Every manifest entry is a plain `bin/treehouse <command>`; there are no shell shims doing work of their own.
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

## Module seams

The commands are thin; everything reusable sits behind a module with one job. Keep it that way when adding features.

- `plan.ts` — everything derived about one worktree (path, base ref, slug/ticket/id, placeholder expansion) from a single `buildWorktreePlan()` call. Pure: no fs, no git, no Herdr. `DEFAULT_BASE` lives here and nowhere else. An unknown `{placeholder}` is an error, not a pass-through.
- `provision.ts` — "make this worktree exist and be usable", shared by `up` and the `worktree.created` hook. `worktreeState: 'just-created'` is how the hook says Herdr already made the checkout but it is still fresh, so `setup` must run.
- `tabs.ts` — the only module that knows Herdr: subcommand names, response decoding, and the quirks (split chain, autostart vs pre-fill, wait-idle + paste + explicit Enter, always an explicit `--pane`, the double busy snapshot). `up`/`down` must contain no herdr subcommand strings.
- `herdr.ts` + `testing/fakeHerdr.ts` — the invoker is a dependency (`EngineDeps.invoke`), with a spawning adapter for production and a recording fake for tests. Responses stay `unknown` so decoding happens once, in `tabs.ts`.
- `config.ts` — one shape declaration (keys *and* value shapes, per level) validated in one pass, returning a typed config plus diagnostics as data. `diagnostics.ts` decides at the call site: unknown keys warn, wrong value shapes stop the run.
- `context.ts` — the only reader of `HERDR_PLUGIN_CONTEXT_JSON`, and the home of `TREEHOUSE_TARGET_PATH` (one env convention for "which repo or worktree"). `actions.ts` (`treehouse action up|down`) resolves it and opens the popup.
- `cli.ts` — each command declares its flags once with help text attached; parsing and `--help` both derive from the declaration, so help cannot drift.

## Development

```bash
bun install
bun run typecheck        # tsc --noEmit, no build step (bun runs .ts directly)
bun test                 # unit + command-level tests, no Herdr session needed
herdr plugin link .      # re-run after editing herdr-plugin.toml
herdr plugin log list --plugin treehouse   # event/action stderr logs
```

Herdr CLI responses are JSON; `src/herdr.ts` wraps invocation and returns the parsed `result`. Never construct pane/tab IDs; always read them from responses.

Tests run with no Herdr session and no `HERDR_ENV`: pass `{ invoke }` from `createFakeHerdr()` plus `insideHerdr: () => true`, and the whole command runs against scripted responses while recording the Herdr calls it made. Tests that need real git mechanics use `createTempRepo()` (throwaway repo, worktrees as siblings inside it). Live verification is still required for anything that touches Herdr's own behaviour; the fake proves the sequence, not that Herdr accepts it.

## Status / open ends

- `worktree.created` hook: **observed live** (herdr 0.7.5). Payload is `{event, data: {type, workspace, worktree}}` with `data.worktree.path` and `data.worktree.branch`, matching `herdr api schema`. It provisions through the same module as `up`, so a repo with only `setup` is covered too. The raw payload is still logged.
- The action entrypoints (`treehouse action up|down`) log the raw `HERDR_PLUGIN_CONTEXT_JSON` to stderr, so `herdr plugin log list --plugin treehouse` is where to look when a popup targets the wrong repo. Confirmed live field names: `workspace_cwd`, `focused_pane_cwd`, `focused_pane_id`, `clicked_url`, `invocation_source`.
- **Prompt submission (herdr 0.7.5), three live-verified quirks, all handled in `tabs.ts`:** `herdr wait agent-status` no longer exists; it is `agent wait <pane> --until idle` plus `agent prompt <pane> <text>`, and `agent prompt` owns submission, so the old `pane run` + explicit `send-keys enter` workaround for bracketed paste is gone. `pane run <pane> <agent>` still starts the agent, but Herdr registers it only once detection sees it, so `agent wait` answers `agent_not_found` for the first second or two. And an agent can report `idle` while its TUI is still starting, which silently swallows the prompt: submit with `--wait --until working` so Herdr confirms delivery, and resubmit when it fails. Do NOT branch on the error code there - a swallowed prompt comes back as `agent_prompt_stalled` or `timeout` depending on how Herdr's 5000ms change-detection window races the `--timeout` (keep `--timeout` well above 5000ms). Ask the agent instead: `agent get <pane>` reports a `state_change_seq` that advances whenever the agent moves, so an unchanged sequence means nothing was picked up and resubmitting is safe.
- `down` treats a registered agent in `idle`/`done` as not busy (tearing it down is the point); `working`/`blocked` agents and non-agent processes still refuse.
- `up` currently requires `HERDR_ENV=1`. Planned (pending the owner deciding Herdr is a keeper): degrade gracefully outside Herdr by running bootstrap only and skipping tab/panes/agent.
- Overlap with the `vk-branch` skill's worktree mode is known and intentionally left until that decision. Details in `~/.claude/CLAUDE.md` under "Herdr + treehouse".

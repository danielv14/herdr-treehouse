# Herdr integration: behaviours and quirks

Everything the engine knows about Herdr lives in `src/herdr/tabs.ts` (subcommand
names, response decoding), `src/herdr/invoker.ts` (spawning and the response
envelope) and `src/herdr/context.ts` (env payloads). This file
collects the version-specific behaviours those modules code around, all
live-observed on herdr 0.7.5 unless noted.

## The response envelope

Most calls answer on stdout with a JSON envelope whose `result` is the payload;
a few (`plugin config-dir`) answer with a bare line, which is the value itself.
`unpackHerdrResponse` in `src/herdr/invoker.ts` is that one rule: strip the
envelope, fall back to the trimmed body when stdout is not JSON, and turn a
non-zero exit into an error carrying stderr (or stdout when stderr is empty). A
spawn that never started is its own error, and both streams are null there, so
that check comes first. The result stays `unknown`: decoding it is `tabs.ts`'s
job, and an envelope without a `result` reads as "no answer" there rather than
as a failure here.

The seam has two adapters, the spawning one above and the recording fake in
`src/testing/fakeHerdr.ts`, and `src/herdr/invoker.test.ts` drives `tabs.ts`
over the real unpacking so the two agree on the shapes it covers. That catches
drift between our own adapters, not drift in Herdr: a changed envelope only
shows up in a live session.

## Workspace lookup

`herdr worktree list --cwd <root>` reports the repo's workspace as
`source.source_workspace_id`. A repo with no open workspace is a *normal*
answer: the field is simply absent from a successful response. A thrown error
is therefore a real failure and must not be swallowed where the answer feeds a
teardown decision — `down` degrading to "no workspace" would skip the
busy-process check entirely. `up` may recover from a failed lookup by creating
the workspace: the worst case there is one extra workspace, not a lost worktree.

## Starting an agent and handing it a prompt

Three quirks stack up here, all handled in `openWorktreeTab`/`submitPrompt`:

1. **Registration lag.** `pane run <pane> <agent>` starts the agent, but Herdr
   registers it only once its detection has seen the process, so `agent wait`
   answers `agent_not_found` for the first second or two. That one error is
   retried until the agent shows up; every other error is real.

2. **Idle before ready.** A freshly started agent can report `idle` while its
   TUI is still starting, and a prompt submitted in that window is silently
   dropped (the tab opens, the task never arrives). Submission therefore uses
   `agent prompt <pane> <text> --wait --until working`, so Herdr confirms
   delivery, and resubmits when it fails.

3. **Error codes race.** A swallowed prompt comes back as either
   `agent_prompt_stalled` or `timeout`, depending on how Herdr's 5000ms
   change-detection window races the `--timeout`. Keep the timeout well above
   5000ms, and do NOT branch on the error code. Instead ask the agent:
   `agent get <pane>` reports a `state_change_seq` that advances whenever the
   agent moves, so an unchanged sequence across a submission means nothing was
   picked up and resubmitting is safe; a changed one means the prompt landed
   (perhaps the turn was over before `--until working` could observe it).

History: on herdr 0.7.4 submission was `pane run` plus an explicit
`send-keys enter`, working around bracketed paste swallowing the trailing
Enter. On 0.7.5 `agent prompt` owns submission; do not go back.

## Context delivery through `pane run`

`pane run <pane> <command>` hands the command to the pane's own shell, which
evaluates it — so `claude --append-system-prompt "$(cat <file>)"` reads the
context file and multi-line content arrives as one argument. That is the whole
premise of writing `context` to a file, and it was checked in a scratch pane
(herdr 0.7.5) before the feature was merged rather than assumed.

## Busy-pane detection

- `pane process-info` must always get an explicit `--pane`: `--current`
  resolves against the UI-focused pane, which may belong to another workspace
  entirely (herdr 0.7.x).
- Prompt tooling (starship etc.) spawns short-lived processes on every prompt
  render, so a single busy snapshot gives false positives. `down` takes two
  snapshots 750ms apart and only trusts a process seen in both.
- Shells always show as running foreground processes; they never count as busy.
- A registered agent in `idle`/`done` is just waiting at its prompt — tearing
  it down with the tab is the point. `working`/`blocked` agents and non-agent
  processes count as busy.

## Tab choreography

- Tabs are opened with `tab create --cwd` (never `herdr worktree open`, which
  opens worktrees as workspaces — see CLAUDE.md's key decisions).
- Pane layout: each configured pane splits the PREVIOUS pane; the first splits
  the main/agent pane.
- `autostart = false` pre-fills a pane command with `pane send-text` (no
  Enter), so verification is one keypress away but two tabs never race for the
  same docker containers/ports.
- Teardown closes the caller's own tab LAST: an agent driving a teardown from
  inside the worktree tab dies with its tab, so everything else must be done
  first.

## Workspace metadata tokens (sidebar)

- Tokens are not persisted across a Herdr server restart; the manifest's
  `[[startup]]` hook re-reports them. The TTL (the maximum Herdr allows) is the
  backstop that ages values out if the plugin stops reporting.
- `--seq` uses the wall clock: each report is its own short-lived process, so a
  counter would reset; milliseconds are monotonic enough across them.
- The TTL applies to set tokens only, so a pure clear does not send one.
- A zero count *clears* the token rather than reporting `0`: an empty repo
  should show nothing in the sidebar.

## Plugin invocations and payloads

- Plugin-invoked processes (actions, link handlers, plugin panes) run with
  cwd = plugin root. The target repo/worktree is carried explicitly:
  `TREEHOUSE_TARGET_PATH` (set by `treehouse action` when it opens a popup),
  falling back to the invocation context's `workspace_cwd`/`focused_pane_cwd`.
  Commands that would otherwise fall back to cwd on a plugin invocation refuse
  instead — the plugin repo itself must never become the target.
- Actions run headless; anything that needs to prompt happens in a popup
  plugin pane (`plugin pane open --placement popup`).
- `HERDR_PLUGIN_CONTEXT_JSON` and `HERDR_PLUGIN_EVENT_JSON` both decode
  tolerantly: the raw payload is kept for the plugin log and malformed fields
  read as absent, because neither payload may take an invocation down (the
  `worktree.created` hook is the one path that runs unattended). Confirmed live
  field names in the context: `workspace_cwd`, `focused_pane_cwd`,
  `focused_pane_id`, `clicked_url`, `invocation_source`.
- The event payload shape (matching `herdr api schema`):
  `{ event, data: { type, workspace, worktree: { path, branch, ... } } }`.
- `herdr plugin log list --plugin treehouse` is the only way to see what Herdr
  actually sent an invocation, which is why actions and the event hook log
  their raw payload on every run.

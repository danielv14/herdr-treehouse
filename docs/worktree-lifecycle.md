# Worktree lifecycle: placement, provisioning, teardown

The short versions of these decisions are in CLAUDE.md ("Key decisions"); this
file keeps the longer reasoning that used to live as code comments.

## Git owns where an existing worktree is

`worktree_dir` only says where a *new* worktree goes. The naming convention
describes worktrees treehouse made — one created by hand, by another tool, or
under a different ticket id sits wherever that tool put it. So `up` asks
`findWorktreeForBranch` before building the plan, and passes the answer in as
the plan's explicit `worktree`. Deriving the path instead sent provisioning off
to create a *second* worktree for a branch git already had checked out, which
git refuses (`already used by worktree at ...`) — after the bootstrap had
already run. The main checkout is included in the answer so "the branch is on
your desk, not in a worktree" can be refused explicitly instead of reading as
"nowhere".

The same reasoning gives `findWorktreeAtPath`: whether a *path* is taken is a
git question, not an `existsSync` question — the directory being there says
nothing about whose branch is checked out in it.

Path comparisons go through `samePath`, which realpaths both sides: git
resolves symlinks like macOS `/var` → `/private/var`, a path built from a
template does not. A path that does not exist compares as written, which is
what a not-yet-created worktree needs.

## One worktree per branch, not per ticket (#32)

`{id}` is the ticket when the branch has one, so two branches of one ticket
derive the same `worktree_dir` path. The second one used to land in the first
one's worktree without a word: nothing is checked out there under its name,
the directory exists, so provisioning said "worktree already exists" and opened
a tab with an agent standing on the other branch.

`worktreePlacements()` returns the ordered spots the convention allows one
branch — the short `{id}` path first, the full-slug path second (that is what
keeps `ABC-1/reducer-approach` and `ABC-1/state-machine-approach` apart). The
placement derivation is pure; only the caller can ask git which spots are
taken:

- **New worktree** (`up`, nothing holds the branch): take the first placement
  no other worktree occupies. One branch per ticket lands on exactly the path
  it always has; a second branch under the same ticket takes the slug path.
- **Existing worktree**: a worktree standing on a placement keeps that
  placement's name, so a disambiguated worktree reopens under the same tab
  label and `{id}` it was created with; one somewhere else entirely keeps the
  convention's short name.

The chosen placement carries its `id` into the plan, so the path, `{id}` in
setup and pane commands, and the tab label all name the same worktree — two
tabs labelled `🌳 abc-123` would defeat the point, and a `{id}` docker project
name would collide the way the paths did. A `worktree_dir` with no room to
disambiguate (no `{id}`, e.g. `../{repo}-{ticket}`) yields one placement and is
refused with an explanation, not silently reused.

`ls` asks for the whole placement set too, which is why a disambiguated slug
path reads as managed rather than off-convention. The managed check is a path
comparison against the *current* branch name, so a branch renamed after
creation trips the `*` marker as well — the worktree no longer stands where
the convention would put that name.

## Sibling layout

`worktree_dir` defaults to `../{repo}-{id}`, and relative paths resolve against
the main checkout rather than cwd ("../foo" must mean the same thing from a
skill, a keybinding and a shell). Deliberately NOT Claude Code's own
`<repo>/.claude/worktrees/` layout: nesting N long-lived worktrees inside the
checkout puts copies of the tree in the path of watchers, test globs, build
contexts and workspace globs, and needs a per-repo `.gitignore` entry the
engine can't guarantee. Sibling also means `cd ../{repo}-{id}` is the whole
navigation story, and worktrees sort next to the repo they belong to.

## Placeholder expansion

An unknown `{placeholder}` is an error, not a pass-through: a typo used to
become a literal `"{wortkree}"` argument that some script then `mkdir`'d. But
config values are shell commands, and braces are ordinary there —
`docker ps --format '{{.Names}}'`, `kubectl -o jsonpath='{.items[0]}'`,
`awk '{print $1}'`, `cp ${HOME}/.env .env` — so only single-word braces not
preceded by `$` are treated as placeholders; everything else passes through
untouched.

Expansion is eager everywhere it matters: `up` expands pane commands before
provisioning, and setup expands its whole command list before running any of
it. A typo'd placeholder is broken config, and broken config must stop the run
before the first command has changed anything — expanding lazily meant a typo
in the second setup command threw only after the first had spent 30 seconds on
`npm ci`, leaving exactly the half-provisioned worktree that aborting is
supposed to prevent.

## Provisioning

`provisionWorktree` is one implementation of "make this worktree exist and be
usable", shared by `up` and the `worktree.created` hook — it unifies
invocation, not configuration (`setup` and `bootstrap` stay two tiers, see
CLAUDE.md).

- A bootstrap replaces worktree creation entirely: it owns branching, env files
  and dependencies. It runs on the hook path too, where the checkout already
  exists, because the rest of what it does is still needed.
- `bootstrap = []` is a truthy empty argv; provisioning checks `?.length`, not
  presence, because spawning `argv[0] === undefined` crashes with a Node type
  error instead of doing the obvious thing.
- Setup belongs to a fresh worktree: re-running `up` on an existing one must
  not trigger another `npm ci` behind your back. `--setup` is the caller saying
  this particular worktree needs it anyway — a worktree that *exists* is not a
  worktree that was *provisioned* (made by hand, by another tool, or before the
  repo had a config), and the engine does not guess from the state of the
  directory.
- `worktreeState: 'just-created'` is how the hook says Herdr already made the
  checkout but it is still fresh, so setup must run.

Branch creation policy (`addWorktree`): an existing branch is reused as-is; a
new one branches from `base`, fetching the remote side of a remote-tracking
base first so it does not fork from a stale fetch. Offline is survivable: warn
and branch from the local ref. Always `--no-track`, so a bare `git push` in the
worktree can never target the base branch.

## Standing agent context (`context` + `{context_file}`)

User-facing behaviour is documented in the README ("Standing context for the
agent"); this is the engine-side reasoning behind `src/worktree/agentContext.ts`.

- **The config owns the text, the `agent` line owns delivery.** Delivery as a
  system prompt (`--append-system-prompt`) is agent-specific, so it lives in
  the agent command through `{context_file}` — legal only there, the way
  `{targets...}` is legal only in bootstrap argv. Nothing in the engine is
  Claude-specific, and the engine writes no instructions of its own: with
  `{branch}`, `{ticket}`, `{worktree}` and `{targets}` the user writes them,
  and the engine gains no judgment.
- **A file, not inlined text.** Multi-line text inside a `pane run` command
  string sits badly with bracketed paste; the shell reads the file once at
  agent start. A `treehouse context` subcommand was rejected because it could
  not re-derive `--target`, which is an `up` invocation fact.
- **The file name is deterministic per worktree** so re-running `up` overwrites
  instead of accumulating, and carries a digest of the worktree path: repo name
  plus `{id}` do not identify a worktree on their own (two repos sharing a
  basename under one ticket), and the exposure window is minutes wide — the
  file is written before provisioning and read after the tab opens.
- **Half-configured is refused, not silent**: `context` with no
  `{context_file}` to read it, and `{context_file}` with no context to put in
  it (including a context that *expands* to nothing, like `{ticket}` on a
  branch without one). Both are invisible bugs otherwise — you only notice when
  the agent knows nothing. The context renders before anything is decided or
  written, so a placeholder typo is reported as a typo, fails before the
  worktree is provisioned, and never leaves a rendered file behind.
- **The two halves layer separately, so they have to end up at the same
  level.** A `{context_file}` in `[defaults].agent` refuses every repo that
  has no `context`, and a per-repo `context` under a `[defaults].agent`
  without `{context_file}` refuses that repo. With several repos configured,
  both halves in `[defaults]` is the arrangement that stays out of the way:
  every repo inherits the agent line, permission posture included, and a repo
  replaces only the text. Since `context` replaces rather than appends, a repo
  cannot opt out of a `[defaults].context` without rewriting the agent line
  too. That follows from replace semantics being the same for every key, and
  is a deliberate consequence rather than an oversight: keep the default text
  true everywhere, or set both halves per repo.
- **It is its own module**: `plan.ts` is pure (no fs) and `provision.ts` is
  about making the worktree exist, which the context file is not part of.
- The `worktree.created` hook provisions only and never resolves an agent
  command, so `{context_file}` never comes up there. One asymmetry follows: a
  half-configured repo provisions fine through the hook and only fails on `up`.

## A model for one tab (`--model` + `model_arg`)

User-facing behaviour is in the README ("Agent command"); this is the reasoning
behind the shape.

- **The problem is `--agent`, not the missing flag.** `--agent` replaces the
  resolved command, so changing one word means restating the rest. A repo with
  `context` set makes that mandatory rather than merely tedious: an agent
  command without `{context_file}` is refused, so a caller cannot pass a short
  one. The copy that follows restates `--dangerously-skip-permissions` in
  whatever generated it, which is the decision the README's agent-command
  section keeps in exactly one place, and it drifts silently when `[defaults]`
  changes.
- **The engine still knows no flags.** An injected `--model` would have been
  the first place it assumed anything about an agent's CLI; `--agent` is an
  opaque string everywhere else. `model_arg` holds the spelling in the config,
  next to the agent command the user already writes, and the engine only fills
  a slot. Same split as `context`: the config owns the text, the `agent` line
  owns delivery.
- **`--agent-args "--model opus"` was the cheaper shape, and engine-ignorance
  is not what decides against it** — an appended opaque string teaches the
  engine nothing either, so that argument settles nothing on its own. What it
  cannot do is keep the agent's spelling out of the *caller*: a skill or a
  keybinding would have to write the flag verbatim, which is the agent-CLI
  knowledge the skills layer must not carry, and it would let a caller append
  permission flags, which is the whole reason the posture decision lives at one
  launch site. Appending also only works for an agent whose flags may come last;
  anything with a subcommand or a positional (`codex exec "<prompt>"`) needs
  placement. `model_arg` buys placement and one stable `--model` across agents
  for one config line.
- **No model name in the config.** A `model` key with a default would be
  maintenance every time a release lands, for a value that should follow
  whatever an ordinary session picks. The name is an invocation fact, so it
  lives on the command line, and an alias the agent resolves itself survives
  releases.
- **Empty is a complete answer.** No `--model` renders the fragment to nothing,
  and the command reads as it did before. That is why the refusals here fire
  only when `--model` is passed, unlike `context`: a `model_arg` nothing uses
  loses nothing, because nothing was asked for. The other half, a `{model_arg}`
  with no key behind it, is the exact mirror of `{context_file}` with no
  `context` — which *is* refused — and it passes for a different reason: the
  mistake surfaces the moment it matters, because the next `--model` against
  that repo is refused for having nowhere to go. An unread `context` never
  surfaces at all; you find out when the agent turns out to know nothing. Keep
  the two reasons apart, or a later `effort_arg` inherits the wrong rule. What is
  refused is a model that would be *dropped* — no `model_arg` to hold it, or an
  agent command with no slot — because the tab opens looking correct either
  way, and nothing about it shows which model answered.
- The assembled command is trimmed: a slot at the end of the command otherwise
  leaves a trailing space in the reported agent line. Inner spacing is left
  alone, so a slot in the middle collapses to a double space, which no shell
  cares about and no rule has to except.

## Teardown (`down`)

- Never `--force`, never kills processes, leaves the branch (PR merge cleans it
  up). Refusing on dirt is the safety property; `git.test.ts` pins that a dirty
  worktree survives the call.
- In interactive mode the tree is re-inspected *after* the confirm: the prompt
  can sit open while another pane writes, and the check must act on the tree
  the user said yes to.
- Busy-inspection failures abort rather than degrade — proceeding without the
  check could delete a worktree under a running dev server. The caller's own
  pane is skipped (the engine itself would count as busy when run from inside
  the tab), and its own tab closes last.
- The process may be running inside the worktree it is about to delete;
  spawning anything from a deleted cwd fails with ENOENT, so it chdirs to the
  main root first.

## Sidebar count reporting order

Both `up` and `down` report the worktree-count token *before* their tab
choreography: the count changed at provisioning/removal, and what follows can
take a minute, throw, or end the process (closing your own tab), none of which
may leave the token stale — Herdr's worktree events do not see git-side
changes. Reports are best-effort and never fail the command.

The gap those two leave is plain git: `git worktree remove` fires no Herdr
event, so the token kept the old number until the TTL aged it out. The
manifest's `workspace.focused` hook closes it, on two decisions worth keeping:

- **Focus, not a git watcher.** The token is read when you look at the sidebar,
  and focus is the event that says you are looking. It does not heal the moment
  right after the git command (you are already focused where you ran it), which
  is accepted: the next workspace switch fixes it, and a watcher for a
  decorative number is not worth the machinery.
- **Every repo, not the focused one.** The sidebar shows all workspace rows at
  once, so the count you want to be right is usually the repo you are *not* in.
  A full `report` is ~120ms for a handful of repos, which is cheap enough that
  scoping it to the focused workspace would buy nothing. Scoping would also
  need a workspace-id-to-repo lookup Herdr does not offer: `workspace get`
  returns no cwd, and the mapping only runs root to workspace.

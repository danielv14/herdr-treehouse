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
keeps `VKT-1/reducer-approach` and `VKT-1/state-machine-approach` apart). The
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
tabs labelled `🌳 vkt-123` would defeat the point, and a `{id}` docker project
name would collide the way the paths did. A `worktree_dir` with no room to
disambiguate (no `{id}`, e.g. `../{repo}-{ticket}`) yields one placement and is
refused with an explanation, not silently reused.

`ls` asks for the whole placement set too, which is why a disambiguated slug
path reads as managed rather than off-convention.

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

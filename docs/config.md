# Config: resolution and validation policy

Field-by-field reference lives in `config.example.toml`; the shape itself is
declared once in `src/config/config.ts`. This file explains the policies around
it.

## Two homes, one layering

A repo's config can live in the central `config.toml` (a `[repos.X]` block) or
in `<repo>/.treehouse.toml` (same fields, no wrapper, no `root`). Resolution
layers lowest to highest: `[defaults]` → `[repos.X]` → the local file. The
local file works standalone, so a repo needs no central entry at all. Which
home fits is a judgment call about the repo's ownership — that is why `onboard`
only exposes `--local` and leaves the choice to the caller.

A `[repos.X]` block is matched to a checkout by `root` (path identity), not by
its key: the key is just a label. `onboard` refuses to add a block when either
home already configures the repo, naming the file, because moving a repo
between homes means removing the old entry — a decision only the reader can
make.

## Validation: warn on unknown, stop on wrong shape

The TOML arrives untyped, so keys AND value shapes are declared once and
checked in a single pass. The severity split is deliberate:

- **Unknown keys warn** and are ignored — the config still works, but a typo'd
  key means a feature silently never happens, so it must be said out loud.
- **Wrong value shapes are errors** and stop the run, because guessing what was
  meant has burned us: a string `setup` ran one command per character, and a
  quoted `autostart = "false"` was truthy and started dev servers that must
  not race.

A field can also constrain its *value*, not only its type: `root` must be an
absolute path after `~` expansion. Such a check is declared with the shape and
reports like any other error, keyed to the field (`repos.X.root`), so it
inherits the blast-radius rules below instead of needing a check of its own at
every call site. A wrong type still reads "expected a string"; only a wrong
value reads "expected an absolute path".

Validators return diagnostics as data; the resolvers report them before
returning, so no call site can obtain a usable config while an unreported error
sits in the data. The validators are private to the module for that reason: the
resolvers are the only way in, so validation is tested where a command meets it.

## Defaults are applied where the layering happens

`base`, `worktree_dir` and `panes` (and each pane's `split`, `ratio` and
`autostart`) have defaults, and the resolvers apply them, so what a consumer
reads is what the engine does. They are therefore always present in a resolved
config: a consumer that forgot a fallback used to get a silently wrong default
where it now gets a type error. Keys with no default stay optional, which is
what keeps "no bootstrap configured" and "no context configured" readable as
absence.

### Blast-radius rules

- A broken block in some *other* repo's config must not stop work in this one:
  repo-scoped errors from other repos demote to warnings. The resolved repo
  name passed to the demotion is the matched entry's key, falling back to the
  checkout's directory name, so a block that broke its own `root` cannot demote
  itself to "another repo's block" and slip through.
- The multi-repo view (`ls`, `report`) demotes further: a repo whose own block
  or local file is broken is skipped with a warning instead of stopping the
  listing. Errors outside any repo block (a malformed `[defaults]`) break every
  entry equally and still stop the run.
- A non-absolute `root` needs no rule of its own: it is a validation error under
  `repos.X.root`, so both paths already handle it. Multi-repo commands skip that
  repo with a warning; single-repo resolution reports it and demotes it when it
  belongs to another repo. Why it must be caught at all: an empty or relative
  root resolves against the caller's cwd (the plugin dir when a hook runs), so
  it would list or report tokens for the wrong repo, and `realpathSync('')`
  resolving to the process cwd would make the block match whichever repo you ran
  from. Validation drops the value it rejects, which is also why matching a
  block by `root` treats an absent root as "no match".
- Repos known only by a local `.treehouse.toml` are invisible to multi-repo
  commands by design: there is deliberately no registry of them.

## TOML footguns encoded in the shape

- `[defaults]` is a table rather than bare top-level keys on purpose: TOML bare
  keys attach to whatever table precedes them, so an `agent = "..."` line
  appended below a `[repos.X]` block would silently become that repo's setting.
- `[repos.X.panes]` (single brackets) parses as one table where a list of
  tables is expected; the validator emits a dedicated message telling you to
  write `[[repos.X.panes]]`, because the generic "expected a list" says nothing
  about the fix.
- In a rendered block, scalar keys must stay above the `[[panes]]` table or
  TOML reads them as pane keys.

## The write side (onboard)

`renderProposedBlock` lives next to the shape it must satisfy, and
`config.test.ts` round-trips its output (commented examples included) through
resolution, so the key names and advertised defaults cannot drift from what
validation accepts. It renders from the same constants the resolvers apply, and
the round-trip pins that: the block's commented `base` and `worktree_dir` lines
resolve to the values the resolver fills in when they stay commented, and its
rendered pane spells out what a bare `[[panes]]` entry gets.
TOML rendering detail: bare keys are letters, digits, dashes and
underscores — anything else is quoted, and JSON string escapes are a subset of
TOML basic string escapes, so `JSON.stringify` renders a valid TOML string
either way.

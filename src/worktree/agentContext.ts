import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentCommandTakesContext, type WorktreePlan } from './plan.ts'

// Standing instructions for the agent that lands in a worktree tab: which
// branch and ticket it stands on, which targets the bootstrap populated, that
// the dev command in the next pane is pre-filled and must not be started. The
// config owns the text and the `agent` command owns how it arrives, so nothing
// here is Claude-specific and the engine writes no instructions of its own.
//
// Its own module rather than more surface on plan.ts (pure, no fs) or
// provision.ts (about making the worktree exist; this file is not part of the
// worktree).

const CONTEXT_DIR = 'treehouse-context'

// Anything a repo name or an {id} can hold that a filename should not.
const fileSafe = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '-')

// Outside any repo, and deterministic per worktree: re-running `up` on the same
// worktree overwrites its context instead of leaving a trail behind. The name
// reads as repo and {id} for whoever opens it, and carries a digest of the
// worktree path because those two do not identify a worktree on their own: two
// repos sharing a basename (~/dev/api and ~/dev-personal/api) under one ticket
// would otherwise share the file, and the window is minutes wide, since the
// file is written before provisioning and read after the tab opens.
const contextFilePath = (plan: WorktreePlan): string => {
  const key = createHash('sha256').update(plan.worktree).digest('hex').slice(0, 8)
  return join(tmpdir(), CONTEXT_DIR, `${fileSafe(plan.repo)}-${fileSafe(plan.id)}-${key}.md`)
}

export type AgentCommandInput = {
  // The agent command as configured, or as given with --agent. Unexpanded:
  // both go through the same expansion, so they behave the same.
  command: string
  // The repo's resolved `context`, unexpanded. Undefined when none is set.
  context?: string
}

// The agent command to run, with the context file written when the command asks
// for one. A file rather than the text inlined into the command string, because
// multi-line text through `pane run` sits badly with bracketed paste; the shell
// reads it once at agent start and it is never touched again.
//
// Half-configured is an error rather than silence, the way a typo'd placeholder
// is: context nothing reads and a command reading a file nothing wrote are both
// bugs, and both are invisible until you notice the agent knows nothing.
export const prepareAgentCommand = (plan: WorktreePlan, input: AgentCommandInput): string => {
  const wantsContext = agentCommandTakesContext(input.command)
  // Render before deciding anything: what matters is the text the agent would
  // get, not what the config holds. `context = "{ticket}"` on a branch with no
  // ticket is configured and still nothing to deliver, and expanding first also
  // means a placeholder typo is reported as a typo even when the agent command
  // is missing its {context_file}.
  //
  // Trimmed: a TOML """ block carries the newline right after the delimiter,
  // and blank lines around a block of instructions are never meaningful.
  const rendered =
    input.context === undefined ? '' : plan.expand(input.context, 'context').trim()

  if (!wantsContext) {
    if (rendered !== '') {
      throw new Error(
        `context is configured for ${plan.repo} but the agent command has no {context_file}, so the text would never reach the agent: ${JSON.stringify(input.command)}. ` +
          'Add it, e.g. agent = \'claude --append-system-prompt "$(cat {context_file})"\', or drop context.',
      )
    }
    return plan.expandAgent(input.command)
  }

  if (rendered === '') {
    throw new Error(
      `the agent command for ${plan.repo} uses {context_file} but the context is empty, so the agent would be handed an empty file: ${JSON.stringify(input.command)}. ` +
        'Set context in [defaults], in the repo block or in .treehouse.toml, or drop {context_file}.',
    )
  }

  // Expand before writing, for the same reason setup expands its whole command
  // list before running any of it: a typo in the agent command must not leave a
  // rendered context behind for a worktree that is never created.
  const path = contextFilePath(plan)
  const command = plan.expandAgent(input.command, path)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${rendered}\n`, { mode: 0o600 })
  return command
}

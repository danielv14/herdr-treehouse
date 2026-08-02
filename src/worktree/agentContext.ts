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

// Outside any repo, and one file per repo and {id}: re-running `up` on the same
// worktree overwrites its context instead of leaving a trail behind.
const contextFilePath = (plan: WorktreePlan): string =>
  join(tmpdir(), CONTEXT_DIR, `${fileSafe(plan.repo)}-${fileSafe(plan.id)}.md`)

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
  // Whitespace-only context is nothing to deliver, and treating it as text would
  // hand the agent a blank system prompt addition.
  const context = input.context?.trim() === '' ? undefined : input.context

  if (!wantsContext) {
    if (context !== undefined) {
      throw new Error(
        `context is configured for ${plan.repo} but the agent command has no {context_file}, so the text would never reach the agent: ${JSON.stringify(input.command)}. ` +
          'Add it, e.g. agent = \'claude --append-system-prompt "$(cat {context_file})"\', or drop context.',
      )
    }
    return plan.expandAgent(input.command)
  }

  if (context === undefined) {
    throw new Error(
      `the agent command for ${plan.repo} uses {context_file} but no context is configured, so the agent would be handed an empty file: ${JSON.stringify(input.command)}. ` +
        'Set context in [defaults], in the repo block or in .treehouse.toml, or drop {context_file}.',
    )
  }

  const path = contextFilePath(plan)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // Trimmed: a TOML """ block carries the newline right after the delimiter,
  // and blank lines around a block of instructions are never meaningful.
  writeFileSync(path, `${plan.expand(context, 'context').trim()}\n`, { mode: 0o600 })
  return plan.expandAgent(input.command, path)
}

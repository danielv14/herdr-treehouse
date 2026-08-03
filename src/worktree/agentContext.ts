import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentCommandTakesContext, type WorktreePlan } from './plan.ts'

// The repo's `context` rendered and put where the agent command can read it,
// returning the command to run. Rationale in docs/worktree-lifecycle.md.

const CONTEXT_DIR = 'treehouse-context'

// Anything a repo name or an {id} can hold that a filename should not.
const fileSafe = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '-')

// Deterministic per worktree, so re-running `up` overwrites instead of leaving
// a trail. Repo and {id} alone do not identify a worktree: two repos sharing a
// basename (~/dev/api and ~/dev-personal/api) under one ticket would share the
// file, and the window is minutes wide (written before provisioning, read
// after the tab opens) — hence the worktree-path digest.
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

// Half-configured is an error rather than silence, the way a typo'd
// placeholder is: context nothing reads and a command reading a file nothing
// wrote are both invisible until you notice the agent knows nothing.
export const prepareAgentCommand = (plan: WorktreePlan, input: AgentCommandInput): string => {
  const wantsContext = agentCommandTakesContext(input.command)
  // Render before deciding: `context = "{ticket}"` on a branch with no ticket
  // is configured and still nothing to deliver, and expanding first reports a
  // placeholder typo as a typo even when {context_file} is missing too.
  // Trimmed because a TOML """ block carries the newline after the delimiter.
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

  // Expand before writing: a typo in the agent command must not leave a
  // rendered context behind for a worktree that is never created.
  const path = contextFilePath(plan)
  const command = plan.expandAgent(input.command, path)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${rendered}\n`, { mode: 0o600 })
  return command
}

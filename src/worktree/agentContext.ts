import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentCommandTakesContext, agentCommandTakesModel, type WorktreePlan } from './plan.ts'

const CONTEXT_DIR = 'treehouse-context'

const fileSafe = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '-')

// Deterministic per worktree, so re-running `up` overwrites instead of leaving
// a trail. Repo and {id} alone do not identify a worktree: two repos sharing a
// basename (~/dev/api and ~/dev-personal/api) under one ticket would share the
// file, and the window is minutes wide (written before provisioning, read
// after the tab opens), hence the worktree-path digest.
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
  // The repo's resolved `model_arg`, unexpanded: the fragment a model is
  // spelled with, e.g. '--model {model}'.
  modelArg?: string
  // The model asked for with --model. Undefined is the normal case, and the
  // reason the two halves below are only checked when it is set.
  model?: string
}

// Nothing was asked for expands to nothing, which is why an unused `model_arg`
// and a `{model_arg}` with no key behind it both pass: the command then reads
// exactly as it did before the model existed as an option. That is the
// asymmetry with `context`, where an empty file reaching the agent is never a
// complete state.
const renderModelArg = (plan: WorktreePlan, input: AgentCommandInput): string => {
  if (input.model === undefined) return ''
  if (input.modelArg === undefined) {
    throw new Error(
      `--model ${input.model} was asked for, but ${plan.repo} has no model_arg to put it in: treehouse does not know how ${JSON.stringify(input.command.split(' ')[0])} spells a model. ` +
        "Add model_arg = '--model {model}' (in [defaults], the repo block or .treehouse.toml) and a {model_arg} to the agent command.",
    )
  }
  if (!agentCommandTakesModel(input.command)) {
    throw new Error(
      `--model ${input.model} was asked for, but the agent command for ${plan.repo} has no {model_arg}, so the model would be dropped and the agent would start on its usual one: ${JSON.stringify(input.command)}. ` +
        "Add the slot, e.g. agent = 'claude {model_arg}'.",
    )
  }
  return plan.expand(input.modelArg, 'model_arg', { model: input.model })
}

export type PreparedAgentCommand = {
  command: string
  contextFile?: string
}

export const prepareAgentCommand = (
  plan: WorktreePlan,
  input: AgentCommandInput,
): PreparedAgentCommand => {
  const modelArg = renderModelArg(plan, input)
  const wantsContext = agentCommandTakesContext(input.command)
  // Render before deciding: `context = "{ticket}"` on a branch with no ticket
  // is configured and still nothing to deliver, and expanding first reports a
  // placeholder typo as a typo even when {context_file} is missing too.
  // Trimmed because a TOML """ block carries a trailing newline, the one
  // before the closing delimiter.
  const rendered =
    input.context === undefined ? '' : plan.expand(input.context, 'context').trim()

  if (!wantsContext) {
    if (rendered !== '') {
      throw new Error(
        `context is configured for ${plan.repo} but the agent command has no {context_file}, so the text would never reach the agent: ${JSON.stringify(input.command)}. ` +
          'Add it, e.g. agent = \'claude --append-system-prompt "$(cat {context_file})"\', or drop context.',
      )
    }
    return { command: plan.expand(input.command, 'agent', { model_arg: modelArg }).trim() }
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
  // Trimmed for the same reason the other branch is: a {model_arg} last in the
  // command leaves a trailing space behind when no model was asked for, and
  // that ends up in the reported agent line.
  const command = plan.expand(input.command, 'agent', { context_file: path, model_arg: modelArg }).trim()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${rendered}\n`, { mode: 0o600 })
  // `mode` applies at creation only, and the name is deterministic, so a file
  // that once ended up readable by anyone else would stay that way through
  // every later `up`.
  chmodSync(path, 0o600)
  return { command, contextFile: path }
}

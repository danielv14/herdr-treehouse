import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RepoConfig } from '../config/config.ts'
import { prepareAgentCommand, type AgentCommandInput } from './agentContext.ts'
import { buildWorktreePlan, type WorktreePlan } from './plan.ts'

// The rules around `context` and `--model` in one place. No git and no Herdr:
// the plan is pure, and the only side effect is the context file, whose path
// comes back from the call.

const MAIN = '/tmp/checkouts/ctx-repo'
const CONFIG_DIR = '/tmp/herdr/plugins/config/treehouse'

const APPEND = 'claude --append-system-prompt "$(cat {context_file})"'

const planFor = (branch: string, repoConfig: Partial<RepoConfig> = {}, targets: string[] = []): WorktreePlan =>
  buildWorktreePlan({
    repoName: 'ctx-repo',
    branch,
    mainRepoRoot: MAIN,
    repoConfig: { root: MAIN, ...repoConfig },
    configDir: CONFIG_DIR,
    targets,
  })

const written: string[] = []

// Same call, with the file it wrote recorded for cleanup.
const prepare = (plan: WorktreePlan, input: AgentCommandInput) => {
  const prepared = prepareAgentCommand(plan, input)
  if (prepared.contextFile) written.push(prepared.contextFile)
  return prepared
}

afterEach(() => {
  for (const path of written.splice(0)) rmSync(path, { force: true })
})

// What the file would be called for this plan, learned from a run that works.
// The refusal tests assert against that name rather than against an empty
// directory, so nothing here goes looking for a filename prefix.
const reserveContextFile = (plan: WorktreePlan): string => {
  const path = prepare(plan, { command: APPEND, context: 'a context that renders' }).contextFile
  expect(path).toBeDefined()
  rmSync(path as string)
  return path as string
}

describe('context delivery', () => {
  test('the command carries the file, and the file the expanded text', () => {
    const plan = planFor('ABC-1/fix-thing', {}, ['services/a', 'packages/b'])
    const prepared = prepare(plan, {
      command: APPEND,
      context: '\nYou are in a worktree of {repo}: {worktree}, branch {branch}, ticket {ticket}.\nTargets: {targets}.\n',
    })

    expect(prepared.contextFile).toBeDefined()
    expect(prepared.command).toBe(`claude --append-system-prompt "$(cat ${prepared.contextFile})"`)
    expect(readFileSync(prepared.contextFile as string, 'utf8')).toBe(
      `You are in a worktree of ctx-repo: ${plan.worktree}, branch ABC-1/fix-thing, ticket abc-1.\n` +
        'Targets: services/a, packages/b.\n',
    )
  })

  test('a repo with no context leaves the command as it was and writes nothing', () => {
    const prepared = prepare(planFor('ABC-2/fix'), { command: 'claude --resume' })
    expect(prepared.command).toBe('claude --resume')
    expect(prepared.contextFile).toBeUndefined()
  })

  test('braces that are not placeholders pass through the agent command', () => {
    const prepared = prepare(planFor('ABC-3/fix'), {
      command: 'docker exec ${HOST} claude --fmt \'{{.Names}}\'',
    })
    expect(prepared.command).toBe('docker exec ${HOST} claude --fmt \'{{.Names}}\'')
  })

  test('re-running overwrites the file instead of accumulating', () => {
    const plan = planFor('ABC-77/fix')
    const first = prepare(plan, { command: APPEND, context: 'first' })
    const second = prepare(plan, { command: APPEND, context: 'second' })

    expect(second.contextFile).toBe(first.contextFile)
    expect(readFileSync(first.contextFile as string, 'utf8')).toBe('second\n')
  })

  test('two worktrees sharing a repo and an id get a file each', () => {
    // Repo plus {id} do not identify a worktree, which is why the name carries
    // a digest of the path.
    const here = prepare(planFor('ABC-78/fix'), { command: APPEND, context: 'here' })
    const elsewhere = prepare(planFor('ABC-78/fix', { worktree_dir: '/tmp/elsewhere/{id}' }), {
      command: APPEND,
      context: 'elsewhere',
    })

    expect(elsewhere.contextFile).not.toBe(here.contextFile)
    expect(readFileSync(here.contextFile as string, 'utf8')).toBe('here\n')
  })

  test('the file is readable by its owner only, and so is the directory', () => {
    const prepared = prepare(planFor('ABC-79/fix'), { command: APPEND, context: 'private' })
    expect(statSync(prepared.contextFile as string).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(prepared.contextFile as string)).mode & 0o777).toBe(0o700)
  })
})

describe('context refusals', () => {
  test('context the agent command never reads is refused, not silently dropped', () => {
    expect(() =>
      prepareAgentCommand(planFor('ABC-1/fix'), {
        command: 'claude --resume',
        context: 'standing instructions',
      }),
    ).toThrow(/context is configured for ctx-repo but the agent command has no \{context_file\}/)
  })

  test('{context_file} with no context to put in it is refused', () => {
    const plan = planFor('ABC-1/fix')
    const path = reserveContextFile(plan)
    expect(() => prepareAgentCommand(plan, { command: APPEND })).toThrow(
      /uses \{context_file\} but the context is empty/,
    )
    expect(existsSync(path)).toBe(false)
  })

  test('a context that expands to nothing is refused rather than written empty', () => {
    // Configured and still nothing to deliver: {ticket} is empty on a branch
    // without one, so the agent would be handed an empty file.
    const plan = planFor('fix/no-ticket-here')
    const path = reserveContextFile(plan)
    expect(() => prepareAgentCommand(plan, { command: APPEND, context: '{ticket}' })).toThrow(
      /uses \{context_file\} but the context is empty/,
    )
    expect(existsSync(path)).toBe(false)
  })

  test('a placeholder typo in the context is reported as a typo', () => {
    expect(() =>
      prepareAgentCommand(planFor('ABC-1/fix'), { command: APPEND, context: 'branch {brnach}' }),
    ).toThrow('unknown placeholder {brnach} in context')
  })

  test('a placeholder typo in the agent command leaves no context file behind', () => {
    const plan = planFor('ABC-3/fix')
    const path = reserveContextFile(plan)
    expect(() =>
      prepareAgentCommand(plan, {
        command: 'claude --cwd {wortkree} --append-system-prompt "$(cat {context_file})"',
        context: 'standing instructions',
      }),
    ).toThrow('unknown placeholder {wortkree} in the agent command')
    expect(existsSync(path)).toBe(false)
  })
})

describe('a model in the declared slot', () => {
  test('--model lands in the slot, alongside the context the repo already had', () => {
    const prepared = prepare(planFor('ABC-5/fix'), {
      command: 'claude --dangerously-skip-permissions {model_arg} --append-system-prompt "$(cat {context_file})"',
      context: 'standing instructions',
      modelArg: '--model {model}',
      model: 'fable',
    })
    expect(prepared.command).toBe(
      'claude --dangerously-skip-permissions --model fable ' +
        `--append-system-prompt "$(cat ${prepared.contextFile})"`,
    )
  })

  test('without a model the slot disappears and the command is what it always was', () => {
    const prepared = prepare(planFor('ABC-6/fix'), {
      command: 'claude --resume {model_arg}',
      modelArg: '--model {model}',
    })
    expect(prepared.command).toBe('claude --resume')
  })

  test('a model_arg nothing asks for is left alone', () => {
    // Unlike a context nothing reads: no model was requested, so nothing is lost.
    const prepared = prepare(planFor('ABC-9/fix'), {
      command: 'claude --resume',
      modelArg: '--model {model}',
    })
    expect(prepared.command).toBe('claude --resume')
  })
})

describe('model refusals', () => {
  test('a model with no model_arg configured is refused', () => {
    expect(() =>
      prepareAgentCommand(planFor('ABC-7/fix'), { command: 'claude --resume', model: 'fable' }),
    ).toThrow(/--model fable was asked for, but ctx-repo has no model_arg to put it in/)
  })

  test('a model with no slot in the agent command is refused', () => {
    expect(() =>
      prepareAgentCommand(planFor('ABC-8/fix'), {
        command: 'claude --resume',
        modelArg: '--model {model}',
        model: 'fable',
      }),
    ).toThrow(/the agent command for ctx-repo has no \{model_arg\}, so the model would be dropped/)
  })

  test('a $-prefixed brace is not a slot, so the model is refused rather than dropped', () => {
    // ${model_arg} is a shell variable the agent's shell expands to nothing.
    expect(() =>
      prepareAgentCommand(planFor('ABC-12/fix'), {
        command: 'claude ${model_arg}',
        modelArg: '--model {model}',
        model: 'fable',
      }),
    ).toThrow(/has no \{model_arg\}, so the model would be dropped/)
  })

  test('a model refusal lands before any context file is written', () => {
    const plan = planFor('ABC-15/fix')
    const path = reserveContextFile(plan)
    expect(() =>
      prepareAgentCommand(plan, { command: APPEND, context: 'standing instructions', model: 'fable' }),
    ).toThrow(/has no model_arg to put it in/)
    expect(existsSync(path)).toBe(false)
  })
})

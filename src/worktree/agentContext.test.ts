import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RepoConfig } from '../config/config.ts'
import { resolvedRepoConfig } from '../testing/repoConfig.ts'
import {
  prepareAgentCommand,
  type AgentCommandInput,
  type PreparedAgentCommand,
} from './agentContext.ts'
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
    repoConfig: resolvedRepoConfig({ root: MAIN, ...repoConfig }),
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

// A real narrowing, so a regression fails on this line instead of inside
// readFileSync with an ERR_INVALID_ARG_TYPE.
const contextFileOf = (prepared: PreparedAgentCommand): string => {
  if (prepared.contextFile === undefined) throw new Error('no context file was written')
  return prepared.contextFile
}

// What the file would be called for this plan, learned from a run that works.
// The refusal tests assert against that name rather than against an empty
// directory, so nothing here goes looking for a filename prefix. No `force` on
// the delete: a path reported but never written should fail loudly.
const reserveContextFile = (plan: WorktreePlan): string => {
  const path = contextFileOf(prepare(plan, { command: APPEND, context: 'a context that renders' }))
  rmSync(path)
  return path
}

describe('context delivery', () => {
  test('the command carries the file, and the file the expanded text', () => {
    const plan = planFor('ABC-1/fix-thing', {}, ['services/a', 'packages/b'])
    const prepared = prepare(plan, {
      command: APPEND,
      context: '\nYou are in a worktree of {repo}: {worktree}, branch {branch}, ticket {ticket}.\nTargets: {targets}.\n',
    })

    const contextFile = contextFileOf(prepared)
    expect(prepared.command).toBe(`claude --append-system-prompt "$(cat ${contextFile})"`)
    expect(readFileSync(contextFile, 'utf8')).toBe(
      `You are in a worktree of ctx-repo: ${plan.worktree}, branch ABC-1/fix-thing, ticket abc-1.\n` +
        'Targets: services/a, packages/b.\n',
    )
  })

  test('a repo with no context leaves the command as it was and writes nothing', () => {
    const plan = planFor('ABC-2/fix')
    const path = reserveContextFile(plan)
    const prepared = prepare(plan, { command: 'claude --resume' })
    expect(prepared.command).toBe('claude --resume')
    expect(prepared.contextFile).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  test('the path is the worktree\'s, not the command\'s or the text\'s', () => {
    // What the refusal tests lean on: a path learned from one working run is the
    // path any other input for this plan would have used.
    const plan = planFor('ABC-80/fix')
    const first = prepare(plan, { command: APPEND, context: 'one' })
    const second = prepare(plan, {
      command: 'codex --context {context_file} {model_arg}',
      context: 'two',
      modelArg: '--model {model}',
      model: 'opus',
    })
    expect(second.contextFile).toBe(first.contextFile)
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
    expect(readFileSync(contextFileOf(first), 'utf8')).toBe('second\n')
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
    expect(readFileSync(contextFileOf(here), 'utf8')).toBe('here\n')
  })

  test('the file is readable by its owner only, and so is the directory', () => {
    const contextFile = contextFileOf(
      prepare(planFor('ABC-79/fix'), { command: APPEND, context: 'private' }),
    )
    expect(statSync(contextFile).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(contextFile)).mode & 0o777).toBe(0o700)
  })

  test('a file that was left readable is narrowed again on the next run', () => {
    // The name is deterministic and the file outlives the run, so a mode set
    // once is not the same as a mode kept.
    const plan = planFor('ABC-81/fix')
    const contextFile = contextFileOf(prepare(plan, { command: APPEND, context: 'private' }))
    chmodSync(contextFile, 0o644)

    prepare(plan, { command: APPEND, context: 'private, again' })
    expect(statSync(contextFile).mode & 0o777).toBe(0o600)
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

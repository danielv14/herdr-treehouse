import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import type { RepoConfig } from '../config/config.ts'
import { resolvedRepoConfig } from '../testing/repoConfig.ts'
import {
  agentCommandTakesContext,
  agentCommandTakesModel,
  buildWorktreePlan,
  worktreePlacements,
  type TemplateSlot,
} from './plan.ts'

const MAIN = '/tmp/checkouts/my-repo'
const CONFIG_DIR = '/tmp/herdr/plugins/config/treehouse'

const plan = (branch: string, repoConfig: Partial<RepoConfig> = {}, targets: string[] = []) =>
  buildWorktreePlan({
    repoName: 'my-repo',
    branch,
    mainRepoRoot: MAIN,
    repoConfig: resolvedRepoConfig({ root: MAIN, ...repoConfig }),
    configDir: CONFIG_DIR,
    targets,
  })

describe('derived fields', () => {
  test('a ticket branch yields ticket, slug and a ticket id', () => {
    const result = plan('ABC-1234/fix-thing')
    expect(result.ticket).toBe('abc-1234')
    expect(result.slug).toBe('abc-1234-fix-thing')
    expect(result.id).toBe('abc-1234')
  })

  test('a branch without a ticket falls back to the slug as id', () => {
    const result = plan('fix/login_bug')
    expect(result.ticket).toBe('')
    expect(result.slug).toBe('fix-login-bug')
    expect(result.id).toBe('fix-login-bug')
  })
})

describe('base ref', () => {
  // The default itself belongs to the resolver that applies it (config.test.ts);
  // here it is a resolved value the plan carries.
  test('comes from the repo config', () => {
    expect(plan('x/y', { base: 'origin/main' }).base).toBe('origin/main')
  })
})

describe('worktree path', () => {
  test('the conventional worktree_dir lands a sibling of the main checkout', () => {
    expect(plan('ABC-1/x').worktree).toBe('/tmp/checkouts/my-repo-abc-1')
  })

  test('relative worktree_dir resolves against the main checkout, not cwd', () => {
    expect(plan('ABC-1/x', { worktree_dir: '../trees/{repo}-{id}' }).worktree).toBe(
      '/tmp/checkouts/trees/my-repo-abc-1',
    )
  })

  test('absolute worktree_dir is used as is', () => {
    expect(plan('ABC-1/x', { worktree_dir: '/var/wt/{id}' }).worktree).toBe('/var/wt/abc-1')
  })

  test('~ expands to the home directory', () => {
    expect(plan('ABC-1/x', { worktree_dir: '~/wt/{id}' }).worktree).toBe(`${homedir()}/wt/abc-1`)
  })

  test('an already-created worktree path overrides worktree_dir', () => {
    const result = buildWorktreePlan({
      repoName: 'my-repo',
      branch: 'ABC-1/x',
      mainRepoRoot: MAIN,
      repoConfig: resolvedRepoConfig({ root: MAIN, worktree_dir: '../ignored-{id}' }),
      configDir: CONFIG_DIR,
      worktree: '/somewhere/herdr-made-this',
    })
    expect(result.worktree).toBe('/somewhere/herdr-made-this')
    expect(result.expand('{worktree}', 'setup')).toBe('/somewhere/herdr-made-this')
  })

  test('{worktree} in worktree_dir is refused instead of passed through', () => {
    expect(() => plan('ABC-1/x', { worktree_dir: '{worktree}-copy' })).toThrow(
      '{worktree} is not available in worktree_dir',
    )
  })
})

describe('placements', () => {
  const placements = (branch: string, repoConfig: Partial<RepoConfig> = {}) =>
    worktreePlacements({
      repoName: 'my-repo',
      branch,
      mainRepoRoot: MAIN,
      repoConfig: resolvedRepoConfig({ root: MAIN, ...repoConfig }),
    })

  test('a ticket branch may go by its ticket, then by its full slug', () => {
    // The second spot is what two branches of one ticket need; the first is
    // still the short path a single branch per ticket has always had.
    expect(placements('ABC-1/reducer-approach')).toEqual([
      { id: 'abc-1', worktree: '/tmp/checkouts/my-repo-abc-1' },
      { id: 'abc-1-reducer-approach', worktree: '/tmp/checkouts/my-repo-abc-1-reducer-approach' },
    ])
  })

  test('a branch without a ticket has one spot, since its slug is already unique', () => {
    expect(placements('fix/login-bug')).toEqual([
      { id: 'fix-login-bug', worktree: '/tmp/checkouts/my-repo-fix-login-bug' },
    ])
  })

  test('a worktree_dir that is already unique per branch has one spot, not a duplicate', () => {
    expect(placements('ABC-1/x', { worktree_dir: '../{repo}-{slug}' })).toEqual([
      { id: 'abc-1', worktree: '/tmp/checkouts/my-repo-abc-1-x' },
    ])
  })

  test('a worktree_dir that ignores {id} has one spot, so the caller can refuse', () => {
    // {ticket} is fixed for every branch of the ticket: there is no second path
    // to offer, and pretending otherwise would hand back the occupied one.
    expect(placements('ABC-1/x', { worktree_dir: '../{repo}-{ticket}' })).toEqual([
      { id: 'abc-1', worktree: '/tmp/checkouts/my-repo-abc-1' },
    ])
  })

  test('the plan built from a placement uses its id everywhere, not just in the path', () => {
    // A pane command with {id} in it (a docker project name, a port file) has
    // the same collision the paths do, so {id} follows the placement.
    const result = buildWorktreePlan({
      repoName: 'my-repo',
      branch: 'ABC-1/state-machine',
      mainRepoRoot: MAIN,
      repoConfig: resolvedRepoConfig({ root: MAIN }),
      configDir: CONFIG_DIR,
      worktree: '/tmp/checkouts/my-repo-abc-1-state-machine',
      id: 'abc-1-state-machine',
    })
    expect(result.id).toBe('abc-1-state-machine')
    expect(result.ticket).toBe('abc-1')
    expect(result.expand('docker compose -p {id}', 'pane')).toBe(
      'docker compose -p abc-1-state-machine',
    )
  })
})

describe('what each slot admits', () => {
  // The scope table as the config sees it: one row per place a template can
  // sit. Declared here rather than imported, so a slot quietly gaining a
  // placeholder fails a test instead of agreeing with itself.
  const BASE = ['repo', 'branch', 'slug', 'ticket', 'id', 'root', 'base']
  const WORKTREE = [...BASE, 'worktree', 'config_dir', 'targets']
  const SCOPE: { slot: TemplateSlot; label: string; admits: string[] }[] = [
    { slot: 'worktree_dir', label: 'worktree_dir', admits: BASE },
    { slot: 'setup', label: 'setup', admits: WORKTREE },
    { slot: 'pane', label: 'a pane command', admits: WORKTREE },
    { slot: 'bootstrap', label: 'bootstrap', admits: WORKTREE },
    { slot: 'context', label: 'context', admits: WORKTREE },
    {
      slot: 'agent',
      label: 'the agent command',
      admits: [...WORKTREE, 'context_file', 'model_arg'],
    },
    { slot: 'model_arg', label: 'model_arg', admits: [...WORKTREE, 'model'] },
  ]
  const EVERY_PLACEHOLDER = [...WORKTREE, 'context_file', 'model_arg', 'model']
  // What only a caller can supply, all of it offered to every slot: what the
  // template admits must be the table's answer, never the caller's.
  const SUPPLIED = { context_file: '/tmp/ctx.md', model_arg: '--model fable', model: 'fable' }

  const expandIn = (slot: TemplateSlot, template: string) =>
    plan('ABC-1/x', {}, ['services/a']).expand(template, slot, SUPPLIED)

  for (const { slot, label, admits } of SCOPE) {
    for (const placeholder of EVERY_PLACEHOLDER) {
      const template = `head {${placeholder}} tail`
      if (admits.includes(placeholder)) {
        test(`${label} expands {${placeholder}}`, () => {
          expect(expandIn(slot, template)).not.toContain(`{${placeholder}}`)
        })
        continue
      }
      test(`${label} refuses {${placeholder}}`, () => {
        const owners = SCOPE.filter((row) => row.admits.includes(placeholder))
        expect(() => expandIn(slot, template)).toThrow(
          owners.length === 1
            ? `{${placeholder}} only expands in ${owners[0].label}, not in ${label}`
            : `{${placeholder}} is not available in ${label}`,
        )
      })
    }
  }

  test('the refusal for {model} points at the slot that fills it in', () => {
    expect(() => expandIn('agent', 'claude --model {model}')).toThrow(
      'The agent command takes {model_arg}, which model_arg fills in.',
    )
  })

  test('a placeholder the slot admits but nobody rendered is an error, not an empty string', () => {
    expect(() => plan('ABC-1/x').expand('cat {context_file}', 'agent')).toThrow(
      '{context_file} is legal in the agent command but nothing was rendered for it',
    )
  })
})

describe('the real paths reach their slot', () => {
  test('worktree_dir is expanded in the worktree_dir slot', () => {
    expect(() => plan('ABC-1/x', { worktree_dir: '{worktree}-copy' })).toThrow(
      '{worktree} is not available in worktree_dir',
    )
    expect(() => plan('ABC-1/x', { worktree_dir: '{config_dir}/trees/{id}' })).toThrow(
      '{config_dir} is not available in worktree_dir',
    )
  })

  test('bootstrap argv is expanded in the bootstrap slot', () => {
    expect(() => plan('ABC-1/x').expandArgv(['s.sh', '{context_file}'])).toThrow(
      '{context_file} only expands in the agent command, not in bootstrap',
    )
    expect(() => plan('ABC-1/x').expandArgv(['s.sh', '{model_arg}'])).toThrow(
      '{model_arg} only expands in the agent command, not in bootstrap',
    )
  })
})

describe('placeholder expansion', () => {
  test('expands every known placeholder', () => {
    const result = plan('ABC-1/x', { base: 'origin/main' })
    expect(
      result.expand(
        '{repo} {branch} {slug} {ticket} {id} {root} {base} {worktree} {config_dir}',
        'setup',
      ),
    ).toBe(
      `my-repo ABC-1/x abc-1-x abc-1 abc-1 ${MAIN} origin/main /tmp/checkouts/my-repo-abc-1 ${CONFIG_DIR}`,
    )
  })

  test('an unknown placeholder fails, naming it and the ones the slot takes', () => {
    expect(() => plan('ABC-1/x').expand('cp {wortkree}/.env .env', 'setup')).toThrow(
      /unknown placeholder \{wortkree\} in setup.*Placeholders in setup: \{repo\}, \{branch\}, \{slug\}, \{ticket\}, \{id\}, \{root\}, \{base\}, \{worktree\}, \{config_dir\}, \{targets\}/s,
    )
  })

  test('the known list follows the slot: worktree_dir names only what it takes', () => {
    expect(() => plan('ABC-1/x', { worktree_dir: '../{wortkree}' })).toThrow(
      'Placeholders in worktree_dir: {repo}, {branch}, {slug}, {ticket}, {id}, {root}, {base}',
    )
  })

  test('an empty ticket expands to an empty string rather than failing', () => {
    expect(plan('fix/thing').expand('[{ticket}]', 'setup')).toBe('[]')
  })

  test('{targets} renders the --target list comma-separated', () => {
    expect(
      plan('ABC-1/x', {}, ['services/a', 'packages/b']).expand('deps: {targets}', 'context'),
    ).toBe('deps: services/a, packages/b')
  })

  test('{targets} with no targets is an empty string, so the text can say so itself', () => {
    expect(plan('ABC-1/x').expand('deps: [{targets}]', 'context')).toBe('deps: []')
  })
})

describe('{config_dir}', () => {
  test('names a script next to the config, in bootstrap argv and in setup alike', () => {
    const result = plan('ABC-1/x')
    expect(result.expandArgv(['{config_dir}/bootstraps/up.sh', '--dir', '{worktree}'])).toEqual([
      `${CONFIG_DIR}/bootstraps/up.sh`,
      '--dir',
      '/tmp/checkouts/my-repo-abc-1',
    ])
    expect(result.expand('cp {config_dir}/templates/.env .env', 'setup')).toBe(
      `cp ${CONFIG_DIR}/templates/.env .env`,
    )
  })
})

describe('the agent command', () => {
  test('gets the ordinary placeholders', () => {
    expect(plan('ABC-1/x').expand('claude --resume --cwd {worktree}', 'agent')).toBe(
      'claude --resume --cwd /tmp/checkouts/my-repo-abc-1',
    )
  })

  test('{context_file} expands to the path it is handed', () => {
    expect(
      plan('ABC-1/x').expand('claude --append-system-prompt "$(cat {context_file})"', 'agent', {
        context_file: '/tmp/ctx.md',
      }),
    ).toBe('claude --append-system-prompt "$(cat /tmp/ctx.md)"')
  })

  test('a placeholder typo in it fails like any other', () => {
    expect(() => plan('ABC-1/x').expand('claude --cwd {wortkree}', 'agent')).toThrow(
      'unknown placeholder {wortkree} in the agent command',
    )
  })

  test('{model_arg} expands to the fragment it is handed', () => {
    expect(
      plan('ABC-1/x').expand('claude {model_arg} --resume', 'agent', {
        model_arg: '--model fable',
      }),
    ).toBe('claude --model fable --resume')
  })

  test('an empty fragment leaves the command as it was', () => {
    // No model asked for is a complete answer, not a missing one: the surviving
    // double space is inert, and collapsing it would mean the one placeholder
    // that also eats its neighbours.
    expect(
      plan('ABC-1/x').expand('claude {model_arg} --resume', 'agent', { model_arg: '' }),
    ).toBe('claude  --resume')
  })

  test('a $-prefixed brace is a shell variable, not a slot', () => {
    // The bug this pins: asking with a substring test made ${model_arg} read as
    // a slot, so the "no slot" refusal missed and the shell dropped the model
    // into an unset variable.
    expect(agentCommandTakesModel('claude ${model_arg}')).toBe(false)
    expect(agentCommandTakesModel('claude {model_arg}')).toBe(true)
    expect(agentCommandTakesContext('cat ${context_file}')).toBe(false)
    expect(agentCommandTakesContext('cat {context_file}')).toBe(true)
  })
})

describe('model_arg', () => {
  test('{model} expands to the model asked for', () => {
    expect(plan('ABC-1/x').expand('--model {model}', 'model_arg', { model: 'fable' })).toBe(
      '--model fable',
    )
  })

  test('ordinary placeholders work there too', () => {
    expect(
      plan('ABC-1/x').expand('--model {model} --tag {ticket}', 'model_arg', { model: 'opus' }),
    ).toBe('--model opus --tag abc-1')
  })

  test('a typo fails there like anywhere else', () => {
    expect(() =>
      plan('ABC-1/x').expand('--model {mdoel}', 'model_arg', { model: 'fable' }),
    ).toThrow('unknown placeholder {mdoel} in model_arg')
  })

  test('the model is inserted literally, not expanded in turn', () => {
    // The model is the one value that reaches a command from the command line
    // rather than from config, so it is worth saying it gets no second pass.
    expect(plan('ABC-1/x').expand('--model {model}', 'model_arg', { model: '{ticket}' })).toBe(
      '--model {ticket}',
    )
  })
})

describe('bootstrap argv', () => {
  test('{targets...} becomes one entry per target', () => {
    const result = plan('ABC-1/x', {}, ['services/a', 'packages/b'])
    expect(result.expandArgv(['s.sh', '--dir', '{worktree}', '{branch}', '{targets...}'])).toEqual([
      's.sh',
      '--dir',
      '/tmp/checkouts/my-repo-abc-1',
      'ABC-1/x',
      'services/a',
      'packages/b',
    ])
  })

  test('{targets...} with no targets drops the entry entirely', () => {
    expect(plan('ABC-1/x').expandArgv(['s.sh', '{targets...}'])).toEqual(['s.sh'])
  })

  test('{targets...} inside a larger argument is refused', () => {
    expect(() => plan('ABC-1/x').expandArgv(['s.sh', '--dirs={targets...}'])).toThrow(
      '{targets...} only expands as a standalone bootstrap argv entry',
    )
  })

  test('{targets} without the ellipsis is refused rather than joined into one argument', () => {
    // It is a real placeholder elsewhere, but in argv it is a mistyped
    // {targets...}, and "services/a, packages/b" as a single argument is not
    // what any bootstrap script is waiting for.
    expect(() => plan('ABC-1/x', {}, ['services/a']).expandArgv(['s.sh', '{targets}'])).toThrow(
      'bootstrap argv takes {targets...} as an entry of its own',
    )
  })

  test('~ expands in bootstrap argv', () => {
    expect(plan('ABC-1/x').expandArgv(['~/scripts/s.sh'])).toEqual([`${homedir()}/scripts/s.sh`])
  })

  test('an unknown placeholder in bootstrap argv fails', () => {
    expect(() => plan('ABC-1/x').expandArgv(['s.sh', '{tikcet}'])).toThrow(
      'unknown placeholder {tikcet} in bootstrap',
    )
  })
})

describe('braces that are not placeholders', () => {
  test.each([
    "docker compose ps --format '{{.Names}}'",
    "kubectl get pods -o jsonpath='{.items[0].metadata.name}'",
    "awk '{print $1}' log.txt",
    'echo ${SHELL}',
    'find . -exec rm {} \;',
  ])('passes %p through untouched', (template) => {
    expect(plan('ABC-1/x').expand(template, 'setup')).toBe(template)
  })

  test('but a single-word brace is still checked', () => {
    expect(() => plan('ABC-1/x').expand('{wortkree}/x', 'setup')).toThrow(
      'unknown placeholder {wortkree}',
    )
  })

  test('{targets...} anywhere in a plain template is refused', () => {
    expect(() => plan('ABC-1/x').expand('--dirs={targets...}', 'pane')).toThrow(
      '{targets...} only expands as a standalone bootstrap argv entry',
    )
  })
})

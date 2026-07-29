import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { DEFAULT_BASE, type RepoConfig } from '../config/config.ts'
import { buildWorktreePlan } from './plan.ts'

const MAIN = '/tmp/checkouts/my-repo'

const plan = (branch: string, repoConfig: Partial<RepoConfig> = {}, targets: string[] = []) =>
  buildWorktreePlan({
    repoName: 'my-repo',
    branch,
    mainRepoRoot: MAIN,
    repoConfig: { root: MAIN, ...repoConfig },
    targets,
  })

describe('derived fields', () => {
  test('a ticket branch yields ticket, slug and a ticket id', () => {
    const result = plan('VKT-1234/fix-thing')
    expect(result.ticket).toBe('vkt-1234')
    expect(result.slug).toBe('vkt-1234-fix-thing')
    expect(result.id).toBe('vkt-1234')
  })

  test('a branch without a ticket falls back to the slug as id', () => {
    const result = plan('fix/login_bug')
    expect(result.ticket).toBe('')
    expect(result.slug).toBe('fix-login-bug')
    expect(result.id).toBe('fix-login-bug')
  })
})

describe('base ref', () => {
  test('defaults to origin/master', () => {
    expect(plan('x/y').base).toBe(DEFAULT_BASE)
    expect(DEFAULT_BASE).toBe('origin/master')
  })

  test('repo config wins', () => {
    expect(plan('x/y', { base: 'origin/main' }).base).toBe('origin/main')
  })
})

describe('worktree path', () => {
  test('defaults to a sibling of the main checkout', () => {
    expect(plan('VKT-1/x').worktree).toBe('/tmp/checkouts/my-repo-vkt-1')
  })

  test('relative worktree_dir resolves against the main checkout, not cwd', () => {
    expect(plan('VKT-1/x', { worktree_dir: '../trees/{repo}-{id}' }).worktree).toBe(
      '/tmp/checkouts/trees/my-repo-vkt-1',
    )
  })

  test('absolute worktree_dir is used as is', () => {
    expect(plan('VKT-1/x', { worktree_dir: '/var/wt/{id}' }).worktree).toBe('/var/wt/vkt-1')
  })

  test('~ expands to the home directory', () => {
    expect(plan('VKT-1/x', { worktree_dir: '~/wt/{id}' }).worktree).toBe(`${homedir()}/wt/vkt-1`)
  })

  test('an already-created worktree path overrides worktree_dir', () => {
    const result = buildWorktreePlan({
      repoName: 'my-repo',
      branch: 'VKT-1/x',
      mainRepoRoot: MAIN,
      repoConfig: { root: MAIN, worktree_dir: '../ignored-{id}' },
      worktree: '/somewhere/herdr-made-this',
    })
    expect(result.worktree).toBe('/somewhere/herdr-made-this')
    expect(result.expand('{worktree}')).toBe('/somewhere/herdr-made-this')
  })

  test('{worktree} in worktree_dir is refused instead of passed through', () => {
    expect(() => plan('VKT-1/x', { worktree_dir: '{worktree}-copy' })).toThrow(
      '{worktree} is not available in worktree_dir',
    )
  })
})

describe('placeholder expansion', () => {
  test('expands every known placeholder', () => {
    const result = plan('VKT-1/x', { base: 'origin/main' })
    expect(result.expand('{repo} {branch} {slug} {ticket} {id} {root} {base} {worktree}')).toBe(
      `my-repo VKT-1/x vkt-1-x vkt-1 vkt-1 ${MAIN} origin/main /tmp/checkouts/my-repo-vkt-1`,
    )
  })

  test('an unknown placeholder fails, naming it and the known ones', () => {
    expect(() => plan('VKT-1/x').expand('cp {wortkree}/.env .env', 'setup')).toThrow(
      /unknown placeholder \{wortkree\} in setup.*\{repo\}, \{branch\}, \{slug\}, \{ticket\}, \{id\}, \{worktree\}, \{root\}, \{base\}/s,
    )
  })

  test('an empty ticket expands to an empty string rather than failing', () => {
    expect(plan('fix/thing').expand('[{ticket}]')).toBe('[]')
  })
})

describe('bootstrap argv', () => {
  test('{targets...} becomes one entry per target', () => {
    const result = plan('VKT-1/x', {}, ['services/a', 'packages/b'])
    expect(result.expandArgv(['s.sh', '--dir', '{worktree}', '{branch}', '{targets...}'])).toEqual([
      's.sh',
      '--dir',
      '/tmp/checkouts/my-repo-vkt-1',
      'VKT-1/x',
      'services/a',
      'packages/b',
    ])
  })

  test('{targets...} with no targets drops the entry entirely', () => {
    expect(plan('VKT-1/x').expandArgv(['s.sh', '{targets...}'])).toEqual(['s.sh'])
  })

  test('{targets...} inside a larger argument is refused', () => {
    expect(() => plan('VKT-1/x').expandArgv(['s.sh', '--dirs={targets...}'])).toThrow(
      '{targets...} only expands as a standalone bootstrap argv entry',
    )
  })

  test('{targets} without the ellipsis is refused rather than silently ignored', () => {
    expect(() => plan('VKT-1/x').expandArgv(['s.sh', '{targets}'])).toThrow(
      'unknown placeholder {targets}',
    )
  })

  test('~ expands in bootstrap argv', () => {
    expect(plan('VKT-1/x').expandArgv(['~/scripts/s.sh'])).toEqual([`${homedir()}/scripts/s.sh`])
  })

  test('an unknown placeholder in bootstrap argv fails', () => {
    expect(() => plan('VKT-1/x').expandArgv(['s.sh', '{tikcet}'])).toThrow(
      'unknown placeholder {tikcet} in bootstrap',
    )
  })
})

describe('braces that are not placeholders', () => {
  // Config values are shell commands, so braces are ordinary there. Only
  // single-word braces are placeholders.
  test.each([
    "docker compose ps --format '{{.Names}}'",
    "kubectl get pods -o jsonpath='{.items[0].metadata.name}'",
    "awk '{print $1}' log.txt",
    'echo ${SHELL}',
    'find . -exec rm {} \;',
  ])('passes %p through untouched', (template) => {
    expect(plan('VKT-1/x').expand(template, 'setup')).toBe(template)
  })

  test('but a single-word brace is still checked', () => {
    expect(() => plan('VKT-1/x').expand('{wortkree}/x', 'setup')).toThrow('unknown placeholder {wortkree}')
  })

  test('{targets...} anywhere in a plain template is refused', () => {
    expect(() => plan('VKT-1/x').expand('--dirs={targets...}', 'a pane command')).toThrow(
      '{targets...} only expands as a standalone bootstrap argv entry',
    )
  })
})

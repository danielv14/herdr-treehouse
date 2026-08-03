import { afterEach, describe, expect, test } from 'bun:test'
import { createTempRepo, type TempRepo } from './testing/tempRepo.ts'
import { refreshWorktreeCount } from './worktreeCount.ts'

let repo: TempRepo | undefined
afterEach(() => {
  repo?.cleanup()
  repo = undefined
})

describe('refreshWorktreeCount', () => {
  test('counts the linked worktrees and reports them', () => {
    repo = createTempRepo()
    repo.git('worktree', 'add', '-b', 'abc-1/thing', `${repo.parent}/repo-abc-1`)
    const reported: Array<[string, number]> = []
    const warnings: string[] = []

    refreshWorktreeCount(
      { reportWorktreeCount: (workspaceId, count) => reported.push([workspaceId, count]) },
      'wA',
      repo.root,
      (message) => warnings.push(message),
    )

    expect(reported).toEqual([['wA', 1]])
    expect(warnings).toEqual([])
  })

  test('a failing report warns instead of throwing', () => {
    repo = createTempRepo()
    const warnings: string[] = []

    refreshWorktreeCount(
      {
        reportWorktreeCount: () => {
          throw new Error('herdr is gone')
        },
      },
      'wA',
      repo.root,
      (message) => warnings.push(message),
    )

    expect(warnings).toEqual(['warning: could not report the worktree count: herdr is gone'])
  })
})

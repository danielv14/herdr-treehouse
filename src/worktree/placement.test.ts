import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { placementOfWorktree, resolveWorktreePlacement } from './placement.ts'
import { createTempRepo, type TempRepo } from '../testing/tempRepo.ts'

// The placement rule against a real repo, with no Herdr anywhere: git is the
// only thing that knows which spots are taken, so the cases that used to be
// reachable only through `up` end to end live here.

let repo: TempRepo

const request = (branch: string, worktree_dir?: string) => ({
  repoName: 'my-repo',
  branch,
  mainRepoRoot: repo.root,
  repoConfig: { root: repo.root, base: 'master', ...(worktree_dir ? { worktree_dir } : {}) },
})

const sibling = (name: string) => join(repo.parent, name)

const addWorktree = (name: string, branch: string) => {
  const path = sibling(name)
  repo.git('worktree', 'add', path, '-b', branch, '--no-track', 'master')
  return path
}

beforeEach(() => {
  repo = createTempRepo('my-repo')
})

afterEach(() => {
  repo.cleanup()
})

describe('a branch with nowhere to be yet', () => {
  test('one branch per ticket lands on the short path, under the ticket id', () => {
    expect(resolveWorktreePlacement(request('ABC-1/fix-thing'))).toEqual({
      id: 'abc-1',
      worktree: sibling('my-repo-abc-1'),
      managed: true,
    })
  })

  test('a branch without a ticket goes by its slug', () => {
    expect(resolveWorktreePlacement(request('experiment/try-something'))).toMatchObject({
      id: 'experiment-try-something',
      worktree: sibling('my-repo-experiment-try-something'),
    })
  })
})

describe('two branches under one ticket', () => {
  // They derive the same {id} path, and the second one used to land in the
  // first one's worktree without a word.
  const reducer = 'ABC-1/reducer-approach'
  const stateMachine = 'ABC-1/state-machine-approach'

  test('the second branch moves to the full-slug path', () => {
    addWorktree('my-repo-abc-1', reducer)
    expect(resolveWorktreePlacement(request(stateMachine))).toEqual({
      id: 'abc-1-state-machine-approach',
      worktree: sibling('my-repo-abc-1-state-machine-approach'),
      managed: true,
    })
  })

  test('the short path goes to whichever branch was created first', () => {
    // The mirror order: the same two branches, the other one first.
    addWorktree('my-repo-abc-1', stateMachine)
    expect(resolveWorktreePlacement(request(reducer))).toMatchObject({
      id: 'abc-1-reducer-approach',
      worktree: sibling('my-repo-abc-1-reducer-approach'),
    })
  })

  test('reopening the disambiguated one returns it under the name it was created with', () => {
    addWorktree('my-repo-abc-1', reducer)
    const second = addWorktree('my-repo-abc-1-state-machine-approach', stateMachine)
    expect(resolveWorktreePlacement(request(stateMachine))).toEqual({
      id: 'abc-1-state-machine-approach',
      worktree: second,
      managed: true,
    })
  })

  test('reopening the first one keeps the short path it took', () => {
    const first = addWorktree('my-repo-abc-1', reducer)
    addWorktree('my-repo-abc-1-state-machine-approach', stateMachine)
    expect(resolveWorktreePlacement(request(reducer))).toMatchObject({
      id: 'abc-1',
      worktree: first,
    })
  })

  test('a worktree_dir with no room to tell them apart is refused', () => {
    // Every branch of the ticket derives one path here, so there is no second
    // spot to move to; saying so beats reusing the first branch's worktree.
    addWorktree('my-repo-abc-1', reducer)
    expect(() => resolveWorktreePlacement(request(stateMachine, '../{repo}-{ticket}'))).toThrow(
      /every path worktree_dir derives for ABC-1\/state-machine-approach is already a worktree of another branch: .*my-repo-abc-1 \(ABC-1\/reducer-approach\)/,
    )
  })
})

describe('a worktree outside the convention', () => {
  // The real case: a worktree made by another tool, named after a ticket that
  // is not in the branch name. Deriving the path instead sent provisioning off
  // to create a second worktree for a branch git already had checked out.
  const branch = 'ui/upgrade-to-ui-in-konto'

  test('keeps its own path, under the convention short name', () => {
    const elsewhere = addWorktree('npm-packages-abc-11206', branch)
    expect(resolveWorktreePlacement(request(branch))).toEqual({
      id: 'ui-upgrade-to-ui-in-konto',
      worktree: elsewhere,
      managed: false,
    })
  })

  test('reads as unmanaged when asked about by path', () => {
    const elsewhere = addWorktree('somewhere-else', branch)
    expect(placementOfWorktree(request(branch), elsewhere)).toMatchObject({
      worktree: elsewhere,
      managed: false,
    })
  })

  test('a worktree on a legal spot reads as managed, named after that spot', () => {
    const path = addWorktree('my-repo-abc-1-state-machine', 'ABC-1/state-machine')
    expect(placementOfWorktree(request('ABC-1/state-machine'), path)).toEqual({
      id: 'abc-1-state-machine',
      worktree: path,
      managed: true,
    })
  })
})

describe('refusals', () => {
  test('a branch checked out in the main checkout is refused, not placed', () => {
    expect(() => resolveWorktreePlacement(request('master'))).toThrow(
      /master is checked out in the main checkout \(.*\), not in a worktree/,
    )
  })

  test('a broken worktree_dir template says which placeholder is wrong', () => {
    expect(() => resolveWorktreePlacement(request('ABC-1/fix', '../{wortkree}'))).toThrow(
      'unknown placeholder {wortkree} in worktree_dir',
    )
  })
})

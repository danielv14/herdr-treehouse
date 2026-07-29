import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { branchFromUrl, slugFromBranch, ticketFromBranch } from './branch.ts'

describe('branch parts', () => {
  test('slugs are trimmed and capped at 40 characters', () => {
    expect(slugFromBranch('--Fix/  Thing--')).toBe('fix-thing')
    expect(slugFromBranch('a'.repeat(60)).length).toBe(40)
  })

  test('a ticket is only recognised at the start of the branch', () => {
    expect(ticketFromBranch('feature/VKT-1234')).toBe('')
    expect(ticketFromBranch('vkt-1234/x')).toBe('vkt-1234')
  })
})

// One sample per handler pins both declarations of "which links we recognise"
// to the same example, so tightening or widening either side stops being silent.
type LinkHandler = { id?: unknown; pattern?: unknown; action?: unknown }

const manifestLinkHandlers = async (): Promise<LinkHandler[]> => {
  const manifest = Bun.TOML.parse(
    await Bun.file(join(import.meta.dir, '..', '..', 'herdr-plugin.toml')).text(),
  ) as { link_handlers?: LinkHandler[] }
  return manifest.link_handlers ?? []
}

const SAMPLES = [
  { handler: 'jira-ticket', url: 'https://example.atlassian.net/browse/ABC-1234', branch: 'ABC-1234/wip' },
  { handler: 'jira-ticket', url: 'https://example.atlassian.net/browse/ABC-1234/', branch: 'ABC-1234/wip' },
  { handler: 'github-issue', url: 'https://github.com/danielv14/herdr-treehouse/issues/42', branch: 'issue-42/wip' },
  { handler: 'github-issue', url: 'https://github.com/danielv14/herdr-treehouse/issues/42/', branch: 'issue-42/wip' },
]

describe('the manifest link handlers and branchFromUrl agree', () => {
  test('every declared handler has a sample, so a new one cannot slip through untested', async () => {
    const declared = (await manifestLinkHandlers()).map((handler) => handler.id)
    expect(declared.sort()).toEqual(['github-issue', 'jira-ticket'])
    for (const id of declared) expect(SAMPLES.some((sample) => sample.handler === id)).toBe(true)
  })

  test('every declared handler routes to the up-from-link action the engine answers with', async () => {
    for (const handler of await manifestLinkHandlers()) expect(handler.action).toBe('up-from-link')
  })

  test.each(SAMPLES)('$url passes the $handler pattern and yields $branch', async ({ handler, url, branch }) => {
    const declared = (await manifestLinkHandlers()).find((candidate) => candidate.id === handler)
    expect(new RegExp(String(declared?.pattern)).test(url)).toBe(true)
    expect(branchFromUrl(url)).toBe(branch)
  })
})

describe('urls the manifest does not hand over', () => {
  // The engine's patterns used to be unanchored substring matches while the
  // manifest's were anchored and host-scoped, so the engine would happily name
  // a branch for URLs Herdr would never route to it.
  const NOT_LINKS = [
    'https://example.atlassian.net/browse/ABC-1234/comments',
    'https://example.atlassian.net/browse/abc-1234',
    'https://github.com/danielv14/herdr-treehouse/pull/42',
    'https://github.com/danielv14/herdr-treehouse/issues',
    'https://elsewhere.example.com/?next=https://github.com/o/r/issues/1',
    'https://notgithub.com/o/r/issues/1',
  ]

  test.each(NOT_LINKS)('%s is rejected by the manifest and by the engine', async (url) => {
    for (const handler of await manifestLinkHandlers()) {
      expect(new RegExp(String(handler.pattern)).test(url)).toBe(false)
    }
    expect(branchFromUrl(url)).toBeUndefined()
  })

  test('no url at all yields nothing, which is what the caller refuses on', () => {
    expect(branchFromUrl(undefined)).toBeUndefined()
    expect(branchFromUrl('')).toBeUndefined()
  })
})

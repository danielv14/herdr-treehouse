// The convention that turns a ticket into a branch and a branch back into its
// parts, in one place, as pure functions.
//
// The URL patterns are declared twice by necessity: Herdr gates on the
// `[[link_handlers]]` patterns in herdr-plugin.toml before the engine ever
// runs, and the engine has to recognise the URL again to name a branch.
// branch.test.ts reads the manifest to keep the two in step.

export const slugFromBranch = (branch: string) =>
  branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

export const ticketFromBranch = (branch: string) => {
  const match = branch.match(/^([a-zA-Z]+-\d+)/)
  return match ? match[1].toLowerCase() : ''
}

// Anchored and host-scoped like the manifest patterns: an unanchored match
// would accept the ticket id from anywhere in the string, including a URL on
// another host that merely contains one.
const LINK_PATTERNS: Array<{ pattern: RegExp; branch: (match: RegExpMatchArray) => string }> = [
  {
    pattern: /^https:\/\/[^./]+\.atlassian\.net\/browse\/([A-Z]+-\d+)\/?$/,
    branch: (match) => `${match[1]}/wip`,
  },
  {
    pattern: /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)\/?$/,
    branch: (match) => `issue-${match[1]}/wip`,
  },
]

// A clicked link carries no judgment, so the branch is mechanical: a wip branch
// named after the ticket. What to DO about it (explore, fix, just read up) is
// the user's or a skill's call, which is why nothing here produces a prompt.
export const branchFromUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined
  for (const { pattern, branch } of LINK_PATTERNS) {
    const match = url.match(pattern)
    if (match) return branch(match)
  }
  return undefined
}

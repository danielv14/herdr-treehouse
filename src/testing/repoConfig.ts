import type { RepoConfig } from '../config/config.ts'

// A resolved RepoConfig for the modules below the resolvers, which take a config
// whose defaults are already applied. The values are spelled out rather than
// imported: what the engine's defaults are is pinned where they are applied,
// in config.test.ts.
export const resolvedRepoConfig = (
  overrides: Partial<RepoConfig> & { root: string },
): RepoConfig => ({
  base: 'origin/master',
  worktree_dir: '../{repo}-{id}',
  panes: [],
  ...overrides,
})

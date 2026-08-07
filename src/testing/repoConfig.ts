import type { RepoConfig } from '../config/config.ts'

// A resolved RepoConfig for the modules below the resolvers, which take a config
// whose defaults are already applied. The values are spelled out rather than
// imported: what the engine's defaults are is pinned where they are applied,
// in config.test.ts.
// Each defaulted key takes `??` rather than riding on spread order: a caller
// forwarding a Partial<RepoConfig> can hand over an explicit `panes: undefined`,
// which spread would let through into a type that promises an array.
export const resolvedRepoConfig = (
  overrides: Partial<RepoConfig> & { root: string },
): RepoConfig => ({
  ...overrides,
  base: overrides.base ?? 'origin/master',
  worktree_dir: overrides.worktree_dir ?? '../{repo}-{id}',
  panes: overrides.panes ?? [],
})

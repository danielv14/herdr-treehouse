import { parseFlags, type CommandSpec } from './cli.ts'
import { resolveRepoConfig } from './config.ts'
import { readWorktreeCreatedEvent } from './context.ts'
import { resolveDeps, type EngineDeps } from './deps.ts'
import { reportDiagnostics } from './diagnostics.ts'
import { findMainRepoRoot } from './git.ts'
import { buildWorktreePlan } from './plan.ts'
import { provisionWorktree } from './provision.ts'

export const BOOTSTRAP_COMMAND: CommandSpec = {
  name: 'bootstrap',
  usage: ['treehouse bootstrap --from-event'],
  summary: 'internal: used by the worktree.created plugin hook',
  flags: [
    { flag: '--from-event', kind: 'boolean', key: 'fromEvent', help: 'read the worktree from HERDR_PLUGIN_EVENT_JSON and provision it' },
  ],
}

export const bootstrap = async (argv: string[], deps: EngineDeps) => {
  const flags = parseFlags(BOOTSTRAP_COMMAND, argv)
  if (!flags.flag('fromEvent')) {
    throw new Error('bootstrap only supports --from-event (used by the worktree.created hook)')
  }
  await bootstrapFromEvent(deps)
}

// Handler for the worktree.created event (Herdr's native worktree flow). Past
// decoding it is the same provisioning `up` uses, so a repo configured with
// only `setup` gets its dependencies here too.
//
// Everything goes to stderr, which is where `herdr plugin log list --plugin
// treehouse` can see it, and the raw payload is logged on every run so a shape
// change shows up before the fields silently read as absent.
export const bootstrapFromEvent = async (deps: EngineDeps) => {
  const { env, warn: log, pluginConfigDir } = resolveDeps(deps)
  const { raw, path: worktreePath, branch } = readWorktreeCreatedEvent(env)
  if (!raw) {
    log('no HERDR_PLUGIN_EVENT_JSON in environment, nothing to do')
    return
  }
  log(`event payload: ${raw}`)

  if (!worktreePath || !branch) {
    log('could not find worktree path/branch in event payload, skipping bootstrap')
    return
  }

  const mainRepoRoot = findMainRepoRoot(worktreePath)
  const { name: repoName, config: repoConfig, diagnostics } = await resolveRepoConfig(mainRepoRoot, pluginConfigDir())
  reportDiagnostics(diagnostics, log)
  if (!repoConfig.bootstrap?.length && !repoConfig.setup?.length) {
    log(`no bootstrap or setup configured for ${repoName}, skipping`)
    return
  }

  const plan = buildWorktreePlan({
    repoName,
    branch,
    mainRepoRoot,
    repoConfig,
    // Herdr created the checkout, so its path is a given rather than a
    // worktree_dir question.
    worktree: worktreePath,
  })
  provisionWorktree(plan, repoConfig, { worktreeState: 'just-created', log, warn: log })
}

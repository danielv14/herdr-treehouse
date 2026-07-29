import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseFlags, type CommandSpec } from './cli.ts'
import { LOCAL_CONFIG_FILE, configPath, diagnosticsForRepo, findRepoEntry, loadConfig } from './config.ts'
import { resolveDeps, type EngineDeps } from './deps.ts'
import { reportDiagnostics } from './diagnostics.ts'
import { findMainRepoRoot } from './git.ts'

export const ONBOARD_COMMAND: CommandSpec = {
  name: 'onboard',
  usage: ['treehouse onboard [--apply]'],
  summary: 'scan the current repo and propose a config entry',
  flags: [
    { flag: '--apply', kind: 'boolean', key: 'apply', help: 'write the proposal to the config' },
    { flag: '--local', kind: 'boolean', key: 'local', help: `target <repo>/${LOCAL_CONFIG_FILE} instead of the plugin config` },
  ],
}

type RepoScan = {
  devCommand?: string
  installCommand?: string
  envFiles: string[]
  hasDockerCompose: boolean
  notes: string[]
}

const scanRepo = async (repoRoot: string): Promise<RepoScan> => {
  const scan: RepoScan = { envFiles: [], hasDockerCompose: false, notes: [] }

  const packageJsonPath = join(repoRoot, 'package.json')
  if (existsSync(packageJsonPath)) {
    const packageJson = await Bun.file(packageJsonPath).json()
    const scripts: Record<string, string> = packageJson.scripts ?? {}
    const candidate = ['dev', 'start'].find((script) => scripts[script])
    if (candidate) scan.devCommand = `npm run ${candidate}`
    if (existsSync(join(repoRoot, 'package-lock.json'))) scan.installCommand = 'npm ci'
    else if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) scan.installCommand = 'pnpm install --frozen-lockfile'
    else if (existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb'))) scan.installCommand = 'bun install --frozen-lockfile'
    else if (existsSync(join(repoRoot, 'yarn.lock'))) scan.installCommand = 'yarn install --frozen-lockfile'
  } else {
    scan.notes.push('no package.json found; set the dev pane command manually')
  }

  scan.envFiles = readdirSync(repoRoot).filter(
    (file) => file.startsWith('.env') && !file.endsWith('.example'),
  )
  scan.hasDockerCompose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml'].some(
    (file) => existsSync(join(repoRoot, file)),
  )

  if (scan.envFiles.length > 0) {
    scan.notes.push(
      `gitignored env files (${scan.envFiles.join(', ')}) will not follow worktrees; add a bootstrap script that copies them`,
    )
  }
  if (scan.hasDockerCompose) {
    scan.notes.push('docker compose detected: keep autostart = false on the dev pane to avoid container/port clashes between tabs')
  }
  return scan
}

// Two shapes of the same fields. The central config namespaces them under
// [repos.X] and needs `root` to find the repo; a repo-local .treehouse.toml is
// already at its repo, so it drops both. Scalars stay above the pane table:
// TOML would otherwise read them as pane keys.
const buildBlock = (repoName: string, repoRoot: string, scan: RepoScan, local: boolean): string => {
  const tomlKey = repoName.includes('.') ? JSON.stringify(repoName) : repoName
  const head = local
    ? [
        `# treehouse config for ${repoName}. Same fields as a [repos.X] block in the`,
        '# central plugin config, minus the wrapper and `root`. Keep scalar keys above',
        '# [[panes]] or TOML reads them as pane keys.',
      ]
    : [`[repos.${tomlKey}]`, `root = "${repoRoot}"`]
  return [
    ...head,
    `# worktree_dir = "../${repoName}-{id}"  # this is the default; set it only for a different layout`,
    `# base = "origin/master"`,
    `# bootstrap = ["path/to/bootstrap.sh", "--dir", "{worktree}", "{branch}", "{targets...}"]`,
    scan.installCommand ? `setup = ["${scan.installCommand}"]` : `# setup = ["npm ci"]  # commands run in a freshly created worktree`,
    '',
    local ? '[[panes]]' : `[[repos.${tomlKey}.panes]]`,
    'split = "down"',
    'label = "dev"',
    scan.devCommand ? `command = "${scan.devCommand}"` : '# command = "npm run dev"',
    'autostart = false',
  ].join('\n')
}

export const onboard = async (argv: string[], deps: EngineDeps) => {
  const { log, warn, pluginConfigDir } = resolveDeps(deps)
  const flags = parseFlags(ONBOARD_COMMAND, argv)
  const apply = flags.flag('apply')
  const local = flags.flag('local')
  const repoRoot = findMainRepoRoot(process.cwd())
  const repoName = basename(repoRoot)
  const localPath = join(repoRoot, LOCAL_CONFIG_FILE)
  const configDir = pluginConfigDir()
  const centralPath = configPath(configDir)

  // Either location already configuring this repo means there is nothing to
  // onboard. Naming the file matters here: moving a repo between the two is a
  // question of removing the old entry, which only the reader can decide.
  //
  // Matched by `root` rather than by the directory name, the same way config
  // resolution matches: a block keyed differently from the directory still
  // configures this repo, and appending a second one would leave two blocks
  // fighting over it.
  const existing = await loadConfig(configDir)
  const configuredEntry = findRepoEntry(existing.config.repos, repoRoot)
  // Another repo's broken block is not this repo's problem; onboard only needs
  // the block names out of the file.
  reportDiagnostics(diagnosticsForRepo(existing.diagnostics, configuredEntry?.[0]), warn)
  if (configuredEntry) {
    const asKey = configuredEntry[0] === repoName ? '' : ` as [repos.${configuredEntry[0]}]`
    throw new Error(`"${repoName}" is already configured${asKey} in ${centralPath} (remove that block first if you are moving it to ${LOCAL_CONFIG_FILE})`)
  }
  if (existsSync(localPath)) {
    throw new Error(`${localPath} already exists (delete it first if you are moving this repo to ${centralPath})`)
  }

  const scan = await scanRepo(repoRoot)
  const block = buildBlock(repoName, repoRoot, scan, local)
  const target = local ? localPath : centralPath

  // In its default mode the proposed block IS the product: nothing is written
  // and the reader pastes it.
  log(`# Proposed config for ${repoName} (${target})\n`)
  log(block)
  if (scan.notes.length > 0) {
    log('\n# Notes:')
    for (const note of scan.notes) log(`# - ${note}`)
  }

  if (!apply) {
    const other = local
      ? `omit --local to target ${centralPath} instead`
      : `add --local to write ${LOCAL_CONFIG_FILE} in the repo instead`
    log(`\nRun again with --apply to write this to ${target}`)
    log(`(${other})`)
    return
  }
  if (local) {
    await Bun.write(localPath, `${block}\n`)
    log(`\nWrote ${localPath}`)
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, `\n${block}\n`)
  log(`\nAppended to ${target}`)
}

import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { LOCAL_CONFIG_FILE, configPath, loadConfig } from './config.ts'
import { findMainRepoRoot } from './git.ts'

type OnboardOptions = {
  apply: boolean
  local: boolean
}

const parseOnboardArgs = (argv: string[]): OnboardOptions => {
  const options: OnboardOptions = { apply: false, local: false }
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true
    else if (arg === '--local') options.local = true
    else throw new Error(`unknown option for onboard: ${arg}`)
  }
  return options
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

export const onboard = async (argv: string[]) => {
  const options = parseOnboardArgs(argv)
  const repoRoot = findMainRepoRoot(process.cwd())
  const repoName = basename(repoRoot)
  const localPath = join(repoRoot, LOCAL_CONFIG_FILE)

  // Either location already configuring this repo means there is nothing to
  // onboard. Naming the file matters here: moving a repo between the two is a
  // question of removing the old entry, which only the reader can decide.
  const existing = await loadConfig()
  if (existing.repos[repoName]) {
    throw new Error(`"${repoName}" is already configured in ${configPath()} (remove that block first if you are moving it to ${LOCAL_CONFIG_FILE})`)
  }
  if (existsSync(localPath)) {
    throw new Error(`${localPath} already exists (delete it first if you are moving this repo to ${configPath()})`)
  }

  const scan = await scanRepo(repoRoot)
  const block = buildBlock(repoName, repoRoot, scan, options.local)
  const target = options.local ? localPath : configPath()

  console.log(`# Proposed config for ${repoName} (${target})\n`)
  console.log(block)
  if (scan.notes.length > 0) {
    console.log('\n# Notes:')
    for (const note of scan.notes) console.log(`# - ${note}`)
  }

  if (!options.apply) {
    const other = options.local
      ? `omit --local to target ${configPath()} instead`
      : `add --local to write ${LOCAL_CONFIG_FILE} in the repo instead`
    console.log(`\nRun again with --apply to write this to ${target}`)
    console.log(`(${other})`)
    return
  }
  if (options.local) {
    await Bun.write(localPath, `${block}\n`)
    console.log(`\nWrote ${localPath}`)
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, `\n${block}\n`)
  console.log(`\nAppended to ${target}`)
}

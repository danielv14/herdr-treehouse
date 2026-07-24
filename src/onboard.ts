import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { configPath, loadConfig } from './config.ts'
import { findMainRepoRoot } from './git.ts'

type OnboardOptions = {
  apply: boolean
}

const parseOnboardArgs = (argv: string[]): OnboardOptions => {
  const options: OnboardOptions = { apply: false }
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true
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
    scan.notes.push('no package.json found; set dev_command manually')
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
    scan.notes.push('docker compose detected: keep dev_autostart = false to avoid container/port clashes between tabs')
  }
  return scan
}

export const onboard = async (argv: string[]) => {
  const options = parseOnboardArgs(argv)
  const repoRoot = findMainRepoRoot(process.cwd())
  const repoName = basename(repoRoot)

  const existing = await loadConfig()
  if (existing.repos[repoName]) {
    throw new Error(`"${repoName}" is already configured in ${configPath()}`)
  }

  const scan = await scanRepo(repoRoot)
  const tomlKey = repoName.includes('.') ? JSON.stringify(repoName) : repoName
  const lines = [
    `[repos.${tomlKey}]`,
    `root = "${repoRoot}"`,
    `# worktree_dir = "../${repoName}-{id}"  # sibling layout; default is ~/.herdr/worktrees/{repo}/{id}`,
    `# base = "origin/master"`,
    `# bootstrap = ["path/to/bootstrap.sh", "--dir", "{worktree}", "{branch}", "{targets...}"]`,
    scan.installCommand ? `setup = ["${scan.installCommand}"]` : `# setup = ["npm ci"]  # commands run in a freshly created worktree`,
    '',
    `[[repos.${tomlKey}.panes]]`,
    'split = "down"',
    'label = "dev"',
    scan.devCommand ? `command = "${scan.devCommand}"` : '# command = "npm run dev"',
    'autostart = false',
  ]
  const block = lines.join('\n')

  console.log(`# Proposed config for ${repoName}\n`)
  console.log(block)
  if (scan.notes.length > 0) {
    console.log('\n# Notes:')
    for (const note of scan.notes) console.log(`# - ${note}`)
  }

  if (!options.apply) {
    console.log(`\nRun again with --apply to append this to ${configPath()}`)
    return
  }
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `\n${block}\n`)
  console.log(`\nAppended to ${path}`)
}

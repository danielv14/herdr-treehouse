// Each command declares its flags once, with help text attached; parsing and
// `--help` are both derived from that declaration, so adding a flag is one edit
// and the help can never drift from what is accepted.
//
// Deliberately not a flag framework: no subcommand trees, no type coercion, no
// negation pairs. Three commands' worth of parsing is all this has to be.

export type FlagKind =
  // present or absent
  | 'boolean'
  // takes the next argv entry
  | 'value'
  // takes the next argv entry and appends; repeatable
  | 'list'

export type FlagSpec = {
  flag: string
  alias?: string
  kind: FlagKind
  // Key the parsed value is read back under. Two flags may share a key when
  // they feed the same list (--target and --targets).
  key: string
  // Shown after the flag name in help, e.g. "<path>".
  placeholder?: string
  // List flags whose single value is delimited, e.g. --targets a,b.
  split?: string
  help: string
}

export type CommandSpec = {
  name: string
  // Usage lines shown at the top of the help output.
  usage: string[]
  summary: string
  flags: FlagSpec[]
  // Free-form lines printed under the flag list.
  notes?: string[]
}

export type ParsedFlags = {
  value: (key: string) => string | undefined
  flag: (key: string) => boolean
  list: (key: string) => string[]
}

export const parseFlags = (command: CommandSpec, argv: string[]): ParsedFlags => {
  const specs = new Map<string, FlagSpec>()
  for (const spec of command.flags) {
    specs.set(spec.flag, spec)
    if (spec.alias) specs.set(spec.alias, spec)
  }

  const values: Record<string, string> = {}
  const booleans: Record<string, boolean> = {}
  const lists: Record<string, string[]> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const spec = specs.get(arg)
    if (!spec) throw new Error(`unknown option for ${command.name}: ${arg}`)
    if (spec.kind === 'boolean') {
      booleans[spec.key] = true
      continue
    }
    index += 1
    const value = argv[index]
    // An empty value counts as missing: `down --path ""` used to fail here, and
    // silently falling back to cwd would tear down whichever worktree the
    // caller happened to stand in.
    if (value === undefined || value === '') throw new Error(`${arg} requires a value`)
    if (spec.kind === 'value') {
      values[spec.key] = value
      continue
    }
    const entries = spec.split
      ? value.split(spec.split).map((entry) => entry.trim()).filter((entry) => entry !== '')
      : [value]
    lists[spec.key] = [...(lists[spec.key] ?? []), ...entries]
  }

  return {
    value: (key) => values[key],
    flag: (key) => booleans[key] ?? false,
    list: (key) => lists[key] ?? [],
  }
}

const flagLabel = (spec: FlagSpec): string => {
  const names = spec.alias ? `${spec.flag}, ${spec.alias}` : spec.flag
  return spec.placeholder ? `${names} ${spec.placeholder}` : names
}

export const renderHelp = (
  header: string,
  commands: CommandSpec[],
  footer: string[] = [],
): string => {
  const labels = commands.flatMap((command) => command.flags.map(flagLabel))
  const width = Math.max(0, ...labels.map((label) => label.length))

  const lines = [header, '', 'Usage:']
  for (const command of commands) {
    for (const usage of command.usage) lines.push(`  ${usage}`)
  }
  for (const command of commands) {
    lines.push('', `${command.name}: ${command.summary}`)
    for (const note of command.notes ?? []) lines.push(`  ${note}`)
    for (const spec of command.flags) {
      lines.push(`  ${flagLabel(spec).padEnd(width)}  ${spec.help}`)
    }
  }
  if (footer.length > 0) lines.push('', ...footer)
  return lines.join('\n')
}

import { describe, expect, test } from 'bun:test'
import { parseFlags } from './cli.ts'
import { COMMANDS, commandHelp, help } from './commands.ts'
import { DOWN_COMMAND } from './down.ts'
import { ONBOARD_COMMAND } from './onboard.ts'
import { UP_COMMAND } from './up.ts'

describe('up flags', () => {
  test('value flags, aliases and booleans', () => {
    const flags = parseFlags(UP_COMMAND, [
      '--repo', '/tmp/repo',
      '-b', 'ABC-1234/fix-thing',
      '--label', 'fix',
      '--prompt', 'do the thing',
      '--agent', 'claude --resume',
      '--no-agent',
      '--no-dev',
      '--focus',
    ])
    expect(flags.value('repo')).toBe('/tmp/repo')
    expect(flags.value('branch')).toBe('ABC-1234/fix-thing')
    expect(flags.value('label')).toBe('fix')
    expect(flags.value('prompt')).toBe('do the thing')
    expect(flags.value('agent')).toBe('claude --resume')
    expect(flags.flag('noAgent')).toBe(true)
    expect(flags.flag('noDev')).toBe(true)
    expect(flags.flag('focus')).toBe(true)
    expect(flags.flag('interactive')).toBe(false)
  })

  test('--target repeats and --targets splits on commas, into one list', () => {
    const flags = parseFlags(UP_COMMAND, [
      '-t', 'services/a',
      '--target', 'packages/b',
      '--targets', 'services/c,packages/d',
    ])
    expect(flags.list('targets')).toEqual(['services/a', 'packages/b', 'services/c', 'packages/d'])
  })

  test('--targets drops empty entries', () => {
    expect(parseFlags(UP_COMMAND, ['--targets', 'a,,b,']).list('targets')).toEqual(['a', 'b'])
  })

  test('an absent list is empty, not undefined', () => {
    expect(parseFlags(UP_COMMAND, []).list('targets')).toEqual([])
  })

  test('unknown flags name the command', () => {
    expect(() => parseFlags(UP_COMMAND, ['--nope'])).toThrow('unknown option for up: --nope')
  })

  test('a value flag without a value fails', () => {
    expect(() => parseFlags(UP_COMMAND, ['--branch'])).toThrow('--branch requires a value')
    expect(() => parseFlags(UP_COMMAND, ['-b'])).toThrow('-b requires a value')
  })

  test('--from-link and --interactive are accepted', () => {
    const flags = parseFlags(UP_COMMAND, ['--from-link', '--interactive'])
    expect(flags.flag('fromLink')).toBe(true)
    expect(flags.flag('interactive')).toBe(true)
  })
})

describe('down flags', () => {
  test('--path and --interactive', () => {
    const flags = parseFlags(DOWN_COMMAND, ['--path', '../repo-abc-1', '--interactive'])
    expect(flags.value('path')).toBe('../repo-abc-1')
    expect(flags.flag('interactive')).toBe(true)
  })

  test('unknown flags name the command', () => {
    expect(() => parseFlags(DOWN_COMMAND, ['--force'])).toThrow('unknown option for down: --force')
  })

  test('--path without a value fails', () => {
    expect(() => parseFlags(DOWN_COMMAND, ['--path'])).toThrow('--path requires a value')
  })
})

describe('onboard flags', () => {
  test('--apply and --local', () => {
    const flags = parseFlags(ONBOARD_COMMAND, ['--apply', '--local'])
    expect(flags.flag('apply')).toBe(true)
    expect(flags.flag('local')).toBe(true)
  })

  test('unknown flags name the command', () => {
    expect(() => parseFlags(ONBOARD_COMMAND, ['-a'])).toThrow('unknown option for onboard: -a')
  })
})

describe('help', () => {
  test('lists every accepted flag and alias of every command', () => {
    const rendered = help()
    for (const command of COMMANDS) {
      for (const spec of command.flags) {
        expect(rendered).toContain(spec.flag)
        if (spec.alias) expect(rendered).toContain(spec.alias)
      }
    }
  })

  test('covers the flags that used to be missing from the hand-written help', () => {
    expect(help()).toContain('--from-link')
    expect(help()).toContain('--interactive')
  })

  test('names every command', () => {
    const rendered = help()
    for (const command of COMMANDS) expect(rendered).toContain(`${command.name}: ${command.summary}`)
  })
})

describe('review fixes', () => {
  test('an empty value counts as missing, so down --path "" cannot retarget cwd', () => {
    expect(() => parseFlags(DOWN_COMMAND, ['--path', ''])).toThrow('--path requires a value')
    expect(() => parseFlags(UP_COMMAND, ['--branch', ''])).toThrow('--branch requires a value')
  })

  test('comma-split entries are trimmed, matching the interactive prompt', () => {
    expect(parseFlags(UP_COMMAND, ['--targets', 'services/a, packages/b ']).list('targets')).toEqual([
      'services/a',
      'packages/b',
    ])
  })

  test('per-command help renders that command only', () => {
    const rendered = commandHelp(UP_COMMAND)
    expect(rendered).toContain('--from-link')
    expect(rendered).not.toContain('--path <worktree>')
  })
})

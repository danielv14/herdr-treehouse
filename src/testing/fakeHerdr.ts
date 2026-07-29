import type { HerdrInvoker } from '../herdr/invoker.ts'

// Recording fake for the Herdr seam: answers scripted responses per subcommand
// and records every call in order, so the whole engine can be driven with no
// Herdr session running.
//
// Responses are keyed by the leading words of the call ("tab create",
// "pane split"); the longest matching key wins. A value can be:
//   - a plain result, reused for every matching call
//   - an array, consumed one entry per matching call (distinct pane ids)
//   - a function of the full argv, for responses that depend on arguments
// A call with no scripted response throws, so tests never pass by accident on
// an unnoticed extra Herdr call.
export type FakeResponse = unknown | unknown[] | ((args: string[]) => unknown)
export type FakeResponses = Record<string, FakeResponse>

export type FakeHerdr = {
  invoke: HerdrInvoker
  calls: string[][]
  commands: () => string[]
  callsMatching: (prefix: string) => string[][]
}

const matchKey = (args: string[], keys: string[]): string | undefined => {
  const line = args.join(' ')
  return keys
    .filter((key) => line === key || line.startsWith(`${key} `))
    .sort((a, b) => b.length - a.length)[0]
}

export const createFakeHerdr = (responses: FakeResponses = {}): FakeHerdr => {
  const calls: string[][] = []
  const queues = new Map<string, unknown[]>()
  const keys = Object.keys(responses)

  const invoke: HerdrInvoker = (args) => {
    calls.push([...args])
    const key = matchKey(args, keys)
    if (key === undefined) {
      throw new Error(`fake herdr: no response scripted for "${args.join(' ')}"`)
    }
    const scripted = responses[key]
    if (typeof scripted === 'function') return (scripted as (args: string[]) => unknown)(args)
    if (!Array.isArray(scripted)) return scripted
    const queue = queues.get(key) ?? [...scripted]
    queues.set(key, queue)
    if (queue.length === 0) {
      throw new Error(`fake herdr: response queue for "${key}" is exhausted (call: ${args.join(' ')})`)
    }
    return queue.shift()
  }

  return {
    invoke,
    calls,
    commands: () => calls.map((call) => call.join(' ')),
    callsMatching: (prefix) =>
      calls.filter((call) => call.join(' ') === prefix || call.join(' ').startsWith(`${prefix} `)),
  }
}

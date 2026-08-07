import type { Diagnostic } from './diagnostics.ts'

// The declare-and-validate engine: a Shape says which keys a table may hold
// and what value each takes, validateTable checks an untyped table against it
// in one pass, and Declared<> derives the TypeScript type from the same
// declaration. Knows nothing about treehouse's config — the shapes themselves,
// and the policy around them, live in config.ts.

// A value constraint on a string, declared with the shape so a bad value
// surfaces as a Diagnostic like every other config error, and a repo-scoped one
// inherits demote-and-skip instead of needing its own warn-and-continue.
export type StringCheck = { expected: string; ok: (value: string) => boolean }

// Keys AND value shapes are declared once and checked in a single pass.
type FieldSpec =
  | { kind: 'string'; values?: readonly string[]; check?: StringCheck }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'string-list' }
  | { kind: 'table'; shape: Shape; required?: readonly string[] }
  | { kind: 'table-list'; shape: Shape; required?: readonly string[] }
  // `required` applies to each entry of the map, not to the map itself.
  | { kind: 'table-map'; shape: Shape; required?: readonly string[] }

export type Shape = Record<string, FieldSpec>

// The type a spec's kind promises, so Declared<> can spell out what a validated
// table holds. A `values` list narrows to its literals; the table kinds recurse.
// Declaring a shape with `as const satisfies Shape` is what keeps the literal
// types this needs while still checking the declaration against Shape.
// A lookup on the discriminant rather than a chain of conditionals: rows cannot
// be order-sensitive (a chain that tested bare `kind: 'string'` before the
// values row would silently widen every enum string), and a kind added to
// FieldSpec without a row fails to compile right here instead of falling
// through to never somewhere downstream.
type FieldValue<S extends FieldSpec> = {
  string: S extends { values: readonly (infer V extends string)[] } ? V : string
  number: number
  boolean: boolean
  'string-list': string[]
  table: S extends { shape: infer T extends Shape } ? Declared<T> : never
  'table-list': S extends { shape: infer T extends Shape } ? Declared<T>[] : never
  'table-map': S extends { shape: infer T extends Shape } ? Record<string, Declared<T>> : never
}[S['kind']]

// What validating against a shape returns. Every key optional: `required` keys
// are enforced as diagnostics, not types, because the caller decides what a
// missing one means (config.ts demotes and skips by its blast-radius rules).
export type Declared<S extends Shape> = { [K in keyof S]?: FieldValue<S[K]> }

// The other half of Declared<>: names the keys a resolver promises to fill in,
// so a resolved type can be derived from the same shape as the declared one.
export type WithDefaulted<T, K extends keyof T> = T & Required<Pick<T, K>>

type Scope = {
  file: string
  // TOML path of the enclosing table; empty at the top level of a file.
  prefix: string
}

const child = (scope: Scope, key: string): Scope => ({
  file: scope.file,
  prefix: scope.prefix === '' ? key : `${scope.prefix}.${key}`,
})

const tableLabel = (scope: Scope) =>
  scope.prefix === '' ? `the top level of ${scope.file}` : `[${scope.prefix}] in ${scope.file}`

const keyPath = (scope: Scope, key: string) =>
  scope.prefix === '' ? key : `${scope.prefix}.${key}`

const keyLabel = (scope: Scope, key: string) => `${keyPath(scope, key)} in ${scope.file}`

export const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const describe = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  switch (typeof value) {
    case 'string':
      return `a string (${JSON.stringify(value)})`
    case 'number':
      return `a number (${value})`
    case 'boolean':
      return `a boolean (${value})`
    case 'object':
      return 'a table'
    default:
      return typeof value
  }
}

const expected = (spec: FieldSpec): string => {
  switch (spec.kind) {
    case 'string':
      return spec.values ? `one of ${spec.values.map((v) => JSON.stringify(v)).join(', ')}` : 'a string'
    case 'number':
      return 'a number'
    case 'boolean':
      return 'a boolean (unquoted true or false)'
    case 'string-list':
      return 'a list of strings'
    case 'table':
      return 'a table'
    case 'table-list':
      return 'a list of tables'
    case 'table-map':
      return 'a table of tables'
  }
}

const validateField = (
  spec: FieldSpec,
  raw: unknown,
  scope: Scope,
  key: string,
  diagnostics: Diagnostic[],
): unknown => {
  const reject = (found = describe(raw), want = expected(spec)) => {
    diagnostics.push({
      severity: 'error',
      key: keyPath(scope, key),
      message: `${keyLabel(scope, key)}: expected ${want}, found ${found}`,
    })
    return undefined
  }

  switch (spec.kind) {
    case 'string':
      if (typeof raw !== 'string') return reject()
      if (spec.values && !spec.values.includes(raw)) return reject(JSON.stringify(raw))
      // The check names its own expectation: a wrong type still reads "expected
      // a string", only a wrong value reads "expected an absolute path".
      if (spec.check && !spec.check.ok(raw)) return reject(JSON.stringify(raw), spec.check.expected)
      return raw
    case 'number':
      return typeof raw === 'number' ? raw : reject()
    case 'boolean':
      return typeof raw === 'boolean' ? raw : reject()
    case 'string-list': {
      if (!Array.isArray(raw)) return reject()
      const wrong = raw.findIndex((entry) => typeof entry !== 'string')
      if (wrong !== -1) return reject(`a list with ${describe(raw[wrong])} at index ${wrong}`)
      return raw
    }
    case 'table':
      if (!isTable(raw)) return reject()
      return validateTable(raw, spec.shape, child(scope, key), diagnostics, spec.required)
    case 'table-list': {
      if (isTable(raw)) {
        // The single-vs-double bracket mistake gets its own message; the
        // generic "expected a list" says nothing about the fix.
        const path = keyPath(scope, key)
        diagnostics.push({
          severity: 'error',
          key: path,
          message: `${keyLabel(scope, key)}: expected ${expected(spec)}, found a single table. Write [[${path}]] (double brackets) so each ${key.replace(/s$/, '')} is its own entry, not [${path}].`,
        })
        return undefined
      }
      if (!Array.isArray(raw)) return reject()
      const entries = raw.map((entry, index) => {
        if (!isTable(entry)) {
          diagnostics.push({
            severity: 'error',
            key: `${keyPath(scope, key)}[${index}]`,
            message: `${keyLabel(scope, key)}[${index}]: expected a table, found ${describe(entry)}`,
          })
          return undefined
        }
        return validateTable(entry, spec.shape, child(scope, `${key}[${index}]`), diagnostics, spec.required)
      })
      return entries.filter((entry) => entry !== undefined)
    }
    case 'table-map': {
      if (!isTable(raw)) return reject()
      const result: Record<string, unknown> = {}
      for (const [name, entry] of Object.entries(raw)) {
        if (!isTable(entry)) {
          diagnostics.push({
            severity: 'error',
            key: keyPath(child(scope, key), name),
            message: `${keyLabel(child(scope, key), name)}: expected a table, found ${describe(entry)}`,
          })
          continue
        }
        result[name] = validateTable(
          entry,
          spec.shape,
          child(child(scope, key), name),
          diagnostics,
          spec.required,
        )
      }
      return result
    }
  }
}

// Returns only known keys with valid values, so everything downstream can trust
// the declared types without re-checking.
export const validateTable = <S extends Shape>(
  raw: Record<string, unknown>,
  shape: S,
  scope: Scope,
  diagnostics: Diagnostic[],
  required: readonly string[] = [],
): Declared<S> => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const spec = shape[key]
    if (!spec) {
      diagnostics.push({
        severity: 'warning',
        key: keyPath(scope, key),
        message: `unknown key "${key}" in ${tableLabel(scope)} (ignored). Known keys: ${Object.keys(shape).join(', ')}`,
      })
      continue
    }
    const validated = validateField(spec, value, scope, key, diagnostics)
    if (validated !== undefined) result[key] = validated
  }
  for (const key of required) {
    if (result[key] === undefined) {
      diagnostics.push({
        severity: 'error',
        key: keyPath(scope, key),
        message: `${tableLabel(scope)}: missing required key "${key}"`,
      })
    }
  }
  // The module's one assertion: validateField's switch returns exactly what the
  // spec's kind promises, which is what Declared<S> spells per key. TS cannot
  // correlate a runtime switch with a conditional type, so it is asserted here,
  // once, instead of cast at every call site reading a validated table.
  return result as Declared<S>
}

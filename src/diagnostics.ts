import type { Diagnostic } from './config.ts'

// The severity decision of config validation: the validators return diagnostics
// as data, and the resolvers in config.ts hand them here before returning.
// Unknown keys are printed and the run continues; a wrong value shape stops it,
// because the alternative is guessing (a quoted "false" that starts a dev
// server, a string setup that runs one command per character).
export const reportDiagnostics = (
  diagnostics: Diagnostic[],
  warn: (message: string) => void,
) => {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'warning') warn(`warning: ${diagnostic.message}`)
  }
  if (errors.length === 0) return
  throw new Error(
    `invalid config:\n${errors.map((error) => `  ${error.message}`).join('\n')}`,
  )
}

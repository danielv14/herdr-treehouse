import type { Diagnostic } from './config.ts'

// The severity decision of config validation: warnings print and the run
// continues, errors stop it (see docs/config.md for why).
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

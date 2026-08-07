// Unknown keys warn (the config still works); a wrong value shape is an error,
// because guessing is how a quoted "false" started dev servers. See
// docs/config.md for the full policy.
export type Diagnostic = {
  severity: 'warning' | 'error'
  message: string
  // TOML path the diagnostic belongs to, e.g. "repos.npm-packages.setup". Lets a
  // caller tell "my repo's block is broken" from "some other repo's block is".
  key?: string
}

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

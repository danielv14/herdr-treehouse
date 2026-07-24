#!/usr/bin/env bash
# Action entrypoint for keybinding/UI invocation. Actions run headless, so
# open the interactive picker as a popup plugin pane instead.
#
# The popup process runs with cwd = plugin root, so the target repo must be
# carried over explicitly: extract the focused workspace's cwd from the action
# context and hand it to the popup via env.
set -euo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

workspace_cwd="$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | bun -e '
const text = await new Response(Bun.stdin.stream()).text()
try {
  console.log(JSON.parse(text).workspace_cwd ?? "")
} catch {
  console.log("")
}
')"

args=(
  plugin pane open
  --plugin workon
  --entrypoint up-interactive
  --placement popup
  --focus
)
if [[ -n "$workspace_cwd" ]]; then
  args+=(--env "WORKON_REPO=$workspace_cwd")
fi

exec "$herdr_bin" "${args[@]}"

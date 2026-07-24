#!/usr/bin/env bash
# Action entrypoint for tearing down the focused worktree tab. The popup
# process runs with cwd = plugin root, so the target worktree must be carried
# over explicitly: use the focused pane's cwd from the action context.
set -euo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"

focused_cwd="$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | bun -e '
const text = await new Response(Bun.stdin.stream()).text()
try {
  const context = JSON.parse(text)
  console.log(context.focused_pane_cwd ?? context.workspace_cwd ?? "")
} catch {
  console.log("")
}
')"

args=(
  plugin pane open
  --plugin workon
  --entrypoint down-interactive
  --placement popup
  --focus
)
if [[ -n "$focused_cwd" ]]; then
  args+=(--env "WORKON_DOWN_PATH=$focused_cwd")
fi

exec "$herdr_bin" "${args[@]}"

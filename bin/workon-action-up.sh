#!/usr/bin/env bash
# Action entrypoint for keybinding/UI invocation. Actions run headless, so
# open the interactive picker as a popup plugin pane instead.
set -euo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"
exec "$herdr_bin" plugin pane open \
  --plugin workon \
  --entrypoint up-interactive \
  --placement popup \
  --focus

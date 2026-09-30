#!/usr/bin/env bash
set -euo pipefail

# Run inside xvfb-run so Electron has both an X server and a window manager.
mkdir -p artifacts
openbox >artifacts/openbox.log 2>&1 &
statusline_wm_pid=$!
cleanup() {
  kill "$statusline_wm_pid" 2>/dev/null || true
  wait "$statusline_wm_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

statusline_wm_ready=0
for statusline_attempt in {1..50}; do
  if [[ "$(xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null)" == *'window id #'* ]]; then
    statusline_wm_ready=1
    break
  fi
  if ! kill -0 "$statusline_wm_pid" 2>/dev/null; then
    cat artifacts/openbox.log
    exit 1
  fi
  sleep 0.1
done
if [[ "$statusline_wm_ready" != 1 ]]; then
  echo 'Openbox did not become ready within five seconds.' >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then set -- npm run test:desktop; fi
"$@"

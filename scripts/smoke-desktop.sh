#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
plugin=$PWD
screenshot=${1:?Usage: ./scripts/smoke-desktop.sh /path/to/panel.png}
profile=$(mktemp -d)
home="$profile/home"
demo="$profile/demo"
app_pid=

cleanup() {
  local status=$?
  if (( status != 0 )) && [[ -f "$profile/orca.log" ]]; then
    tail -n 30 "$profile/orca.log" >&2
  fi
  if [[ -n "$app_pid" ]]; then
    kill -- "-$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  # Electron helpers can still flush profile state as the main process exits.
  for _attempt in {1..4}; do
    if rm -rf -- "$profile" 2>/dev/null; then return "$status"; fi
    sleep 0.25
  done
  if rm -rf -- "$profile"; then return "$status"; fi
  return "$((status == 0 ? 1 : status))"
}
trap cleanup EXIT

mkdir -p "$home/.config" "$home/.cache" "$demo/.orca"
cp -R scripts/fixtures/desktop-revise "$demo/.orca/playbooks"
isolated=(env -i "PATH=$PATH" "HOME=$home" CI=1 ORCA_BACKGROUND_LAUNCH=1)
app_args=(--remote-debugging-port=0)
case "$(uname -s)" in
  Darwin)
    bundle=${ORCA_SMOKE_MAC_APP:?Set ORCA_SMOKE_MAC_APP to the extracted app bundle}
    app="$bundle/Contents/MacOS/Orca"
    cli="$bundle/Contents/Resources/bin/orca"
    user_data="$profile/orca"
    isolated+=("ORCA_USER_DATA_PATH=$user_data")
    app_args+=("--user-data-dir=$user_data")
    ;;
  Linux)
    app=/opt/Orca/orca-ide
    cli=orca-ide
    user_data="$home/.config/orca"
    isolated+=("DISPLAY=${DISPLAY:?Run under Xvfb}" "XAUTHORITY=${XAUTHORITY:?Run under xvfb-run}")
    app_args+=(--password-store=basic --disable-dev-shm-usage)
    # A disposable Docker container can prohibit the Chromium setuid sandbox.
    if [[ ${ORCA_SMOKE_NO_SANDBOX:-0} == 1 ]]; then
      app_args+=(--no-sandbox)
    fi
    ;;
  *)
    printf 'Unsupported desktop platform\n' >&2
    exit 1
    ;;
esac
timeout_cmd=$(command -v timeout || command -v gtimeout)
orca() {
  "$timeout_cmd" 25s "${isolated[@]}" "$cli" "$@" --json
}

"${isolated[@]}" git -C "$demo" init -q -b main
"${isolated[@]}" git -C "$demo" -c user.name='Smoke Test' -c user.email='smoke@example.invalid' \
  commit --allow-empty -qm 'Start demo'

# Put Electron and its helpers in a separate process group on both platforms.
python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
  "${isolated[@]}" "$app" "${app_args[@]}" >"$profile/orca.log" 2>&1 &
app_pid=$!

port_file="$user_data/DevToolsActivePort"
deadline=$((SECONDS + 45))
until [[ -s "$port_file" ]] && orca status | jq -e '.result.runtime.reachable and .result.runtime.state == "ready"' >/dev/null; do
  if ! kill -0 "$app_pid" 2>/dev/null || (( SECONDS >= deadline )); then
    printf 'Orca did not start\n' >&2
    exit 1
  fi
  sleep 1
done
read -r port <"$port_file"

orca repo add --path "$demo" >/dev/null
orca worktree activate --worktree "path:$demo" >/dev/null
orca plugin system on >/dev/null
approval_status=0
orca plugin install "$plugin" >"$profile/approval.json" || approval_status=$?
if [[ "$approval_status" != 3 ]]; then
  printf 'Expected an approval request from the fresh Orca profile\n' >&2
  cat "$profile/approval.json" >&2
  exit 1
fi
fingerprint=$(jq -er '.error.data.approvalFingerprint' "$profile/approval.json")
orca plugin install "$plugin" --approve "$fingerprint" >/dev/null
orca plugin open local.playbooks --panel playbooks >/dev/null

node scripts/smoke-panel.mjs "$port" "$demo"
orca plugin shot local.playbooks --panel playbooks --out "$screenshot" |
  jq -e '.result | .settled and (.errors | length == 0)' >/dev/null
test -s "$screenshot"

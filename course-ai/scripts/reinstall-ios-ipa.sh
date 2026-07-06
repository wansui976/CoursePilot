#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_IPA="$ROOT_DIR/src-tauri/gen/apple/build/arm64/course-ai.ipa"

BUILD=1
DEVICE_ID="${DEVICE_ID:-}"
IPA_PATH="$DEFAULT_IPA"

usage() {
  cat <<'EOF'
Usage:
  pnpm ios:reinstall [options]
  ./scripts/reinstall-ios-ipa.sh [options]

Build/sign the iOS IPA with the current Xcode/Tauri configuration, then install
it on a connected iPad/iPhone.

Options:
  --skip-build         Install the existing IPA without rebuilding/signing.
  --device <id>        Device identifier or UDID. Overrides auto-detection.
  --ipa <path>         IPA path to install. Defaults to Tauri iOS build output.
  --list-devices       Print devices known to devicectl, then exit.
  -h, --help           Show this help.

Examples:
  pnpm ios:reinstall
  pnpm ios:reinstall -- --skip-build
  pnpm ios:reinstall -- --device 5401A0DE-E78C-5F64-B08C-5A695AB0E672
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

abs_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s\n' "$PWD/$path"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --skip-build)
      BUILD=0
      shift
      ;;
    --device)
      [[ $# -ge 2 ]] || die "--device requires a value"
      DEVICE_ID="$2"
      shift 2
      ;;
    --ipa)
      [[ $# -ge 2 ]] || die "--ipa requires a value"
      IPA_PATH="$(abs_path "$2")"
      shift 2
      ;;
    --list-devices)
      xcrun devicectl list devices
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

need_cmd pnpm
need_cmd xcrun
need_cmd python3

auto_detect_device() {
  local json_file
  json_file="$(mktemp)"
  trap 'rm -f "$json_file"' RETURN

  xcrun devicectl list devices --json-output "$json_file" >/dev/null

  python3 - "$json_file" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

devices = data.get("result", {}).get("devices", [])
physical_ios = []
available = []

for device in devices:
    hardware = device.get("hardwareProperties", {})
    properties = device.get("deviceProperties", {})
    connection = device.get("connectionProperties", {})
    platform = hardware.get("platform")
    reality = hardware.get("reality")
    if platform != "iOS" or reality != "physical":
        continue

    name = properties.get("name") or "(unnamed)"
    identifier = device.get("identifier") or hardware.get("udid") or ""
    tunnel = connection.get("tunnelState") or "unknown"
    pairing = connection.get("pairingState") or "unknown"
    transport = connection.get("transportType") or "unknown"
    ddi = bool(properties.get("ddiServicesAvailable"))
    physical_ios.append((name, identifier, tunnel, pairing, transport, ddi))

    if identifier and (ddi or tunnel == "connected" or (pairing == "paired" and transport != "unknown")):
        available.append((name, identifier))

if len(available) == 1:
    print(available[0][1])
    sys.exit(0)

if len(available) > 1:
    print("Multiple available iOS devices found. Use --device <id>.", file=sys.stderr)
    for name, identifier in available:
        print(f"  {name}: {identifier}", file=sys.stderr)
    sys.exit(2)

print("No available physical iOS device found.", file=sys.stderr)
if physical_ios:
    print("Known physical iOS devices:", file=sys.stderr)
    for name, identifier, tunnel, pairing, transport, ddi in physical_ios:
        state = "available" if (ddi or tunnel == "connected" or (pairing == "paired" and transport != "unknown")) else "unavailable"
        print(f"  {name}: {identifier} ({state}, pairing={pairing}, transport={transport}, tunnel={tunnel}, ddi={ddi})", file=sys.stderr)
else:
    print("No physical iOS devices are known to devicectl.", file=sys.stderr)
print("Unlock the iPad, keep it trusted, reconnect USB if needed, then retry.", file=sys.stderr)
sys.exit(2)
PY
}

if [[ "$BUILD" -eq 1 ]]; then
  printf 'Building and signing IPA with Tauri/Xcode...\n'
  (cd "$ROOT_DIR" && CI=true pnpm tauri ios build)
else
  printf 'Skipping build; using existing IPA.\n'
fi

[[ -f "$IPA_PATH" ]] || die "IPA not found: $IPA_PATH"

if [[ -z "$DEVICE_ID" ]]; then
  printf 'Detecting connected iOS device...\n'
  DEVICE_ID="$(auto_detect_device)"
fi

printf 'Installing IPA:\n  %s\nDevice:\n  %s\n' "$IPA_PATH" "$DEVICE_ID"
xcrun devicectl device install app --device "$DEVICE_ID" "$IPA_PATH"
printf 'Done.\n'

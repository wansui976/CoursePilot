#!/usr/bin/env bash
# 取 sherpa-onnx 的 iOS xcframework（本地中文识别 SenseVoice / Qwen3-ASR），解到 src-tauri/sherpa-onnx.xcframework。
#
# 为什么要先准备：Xcode 规划构建时就要看到这个 xcframework（gen/apple/project.yml 里把它嵌进 app），
# 而 Rust 绑定的构建脚本要等到 Xcode 的「Build Rust Code」阶段才会拷它——那时已经晚了。
# 这里写的版本戳和构建脚本用的一样，它看到戳对得上就不再重拷。
# CI 的 iOS 构建也先跑它（.github/workflows/build-check.yml、ios-release.yml）。
#
# 用法：course-ai/scripts/prepare-sherpa-ios.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
VERSION="$(awk '/^name = "sherpa-onnx-sys"$/ { getline; gsub(/version = |"/, ""); print }' "$TAURI_DIR/Cargo.lock")"
STEM="sherpa-onnx-v$VERSION-ios-shared-onnxruntime-static"
ASSET="$STEM.xcframework.zip"
case "$VERSION" in
  2.0.1) SHA256="fc4c665e694322ced5393aafafaae6bb3e0a7449d98d5db60bc220ac7ac4cbc9" ;;
  *) echo "没有 sherpa-onnx $VERSION 的 iOS 包哈希：升级 Cargo.lock 时在这里补上" >&2; exit 1 ;;
esac

DEST="$TAURI_DIR/sherpa-onnx.xcframework"
STAMP="$TAURI_DIR/.sherpa-onnx-xcframework-version"
if [[ -d "$DEST" && "$(cat "$STAMP" 2>/dev/null)" == "$STEM" ]]; then
  echo "已就绪：$DEST（$STEM）"
  exit 0
fi

CACHE="${SHERPA_ONNX_ARCHIVE_DIR:-${TMPDIR:-/tmp}/courseai-sherpa}"
mkdir -p "$CACHE"
ARCHIVE="$CACHE/$ASSET"
if [[ ! -f "$ARCHIVE" ]] || ! echo "$SHA256  $ARCHIVE" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "Downloading $ASSET"
  curl -L --fail --retry 5 --retry-delay 3 --retry-all-errors -C - -o "$ARCHIVE" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/xcframework/$ASSET" || true
fi
echo "$SHA256  $ARCHIVE" | shasum -a 256 -c -

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q "$ARCHIVE" -d "$WORK"
SRC="$(find "$WORK" -maxdepth 2 -type d -name '*.xcframework' | head -1)"
[[ -n "$SRC" ]] || { echo "压缩包里没有 xcframework" >&2; exit 1; }
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
echo "$STEM" > "$STAMP"
echo "Prepared $DEST"
# CI 上让 Rust 绑定的构建脚本也从这份已下载的包取，不再自己下一遍。
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "SHERPA_ONNX_ARCHIVE_DIR=$CACHE" >> "$GITHUB_ENV"
fi

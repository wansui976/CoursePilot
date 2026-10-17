#!/usr/bin/env bash
set -euo pipefail

repo_root="${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
binary_dir="$repo_root/course-ai/src-tauri/binaries"
target="$(rustc -vV | awk '/^host:/ { print $2 }')"

if [[ "$target" != *-apple-darwin ]]; then
  echo "prepare-macos-sidecars.sh must run on macOS, got target: $target" >&2
  exit 1
fi

mkdir -p "$binary_dir"

# ffmpeg：固定版本的静态构建（eugeneware/ffmpeg-static，npm 包 ffmpeg-static 背后的项目），
# 按架构取原生二进制，并校验 SHA-256。只依赖 macOS 系统框架，可直接打进安装包。
# 原先的 evermeet.cx「最新版」地址已下线（HTTP 410），而且只有 Intel 版。
# 升级时改 FFMPEG_RELEASE，并用 Release 页面公布的 .gz 摘要更新下面两个哈希。
FFMPEG_RELEASE="b6.1.1"
case "$target" in
  aarch64-apple-darwin)
    ffmpeg_asset="ffmpeg-darwin-arm64.gz"
    ffmpeg_sha256="8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa"
    ;;
  x86_64-apple-darwin)
    ffmpeg_asset="ffmpeg-darwin-x64.gz"
    ffmpeg_sha256="929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106"
    ;;
  *)
    echo "no pinned ffmpeg build for $target" >&2
    exit 1
    ;;
esac

ffmpeg="$binary_dir/ffmpeg-$target"
echo "Downloading ffmpeg $FFMPEG_RELEASE ($ffmpeg_asset) for $target"
curl -L --fail --retry 5 --retry-delay 3 --retry-all-errors \
  -o "$binary_dir/$ffmpeg_asset" \
  "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/$ffmpeg_asset"
echo "$ffmpeg_sha256  $binary_dir/$ffmpeg_asset" | shasum -a 256 -c -
gunzip -c "$binary_dir/$ffmpeg_asset" > "$ffmpeg"
rm -f "$binary_dir/$ffmpeg_asset"
chmod 755 "$ffmpeg"
xattr -c "$ffmpeg" 2>/dev/null || true
codesign --force --sign - "$ffmpeg"

ytdlp="$binary_dir/yt-dlp-$target"
echo "Downloading yt-dlp for $target"
curl -L --fail --retry 3 --retry-delay 2 \
  -o "$ytdlp" \
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
chmod 755 "$ytdlp"
xattr -c "$ytdlp" 2>/dev/null || true
codesign --force --sign - "$ytdlp"

echo "Prepared macOS sidecars:"
"$ffmpeg" -version | sed -n '1,2p'
"$ytdlp" --version
ls -lh "$ffmpeg" "$ytdlp"

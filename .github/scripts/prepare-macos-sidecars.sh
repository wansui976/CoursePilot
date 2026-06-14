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

ffmpeg="$binary_dir/ffmpeg-$target"
echo "Downloading ffmpeg for $target"
curl -L --fail --retry 3 --retry-delay 2 \
  -o "$binary_dir/ffmpeg.zip" \
  "https://evermeet.cx/ffmpeg/getrelease/zip"
unzip -qo "$binary_dir/ffmpeg.zip" -d "$binary_dir"
mv "$binary_dir/ffmpeg" "$ffmpeg"
rm -f "$binary_dir/ffmpeg.zip"
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

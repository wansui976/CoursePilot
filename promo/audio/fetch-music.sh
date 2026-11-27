#!/usr/bin/env bash
# 背景音乐：Kevin MacLeod《Inspired》，CC BY 4.0（incompetech.com）。成片要署名，见 README。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p music
[ -f music/Inspired.mp3 ] || curl -fL -o music/Inspired.mp3 https://incompetech.com/music/royalty-free/mp3-royaltyfree/Inspired.mp3

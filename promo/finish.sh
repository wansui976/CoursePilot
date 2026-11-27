#!/usr/bin/env bash
# 渲好的画面 + 合成好的声音 → 成片。
#   ./finish.sh out/promo-16x9 120        （读 out/promo-16x9.mp4 和 .events.json）
# 出：<名>.final.mp4（音乐 + 音效，已经给旁白让出位置），<名>.sfx.wav / .music.wav（分轨，配音后自己混）
set -euo pipefail
cd "$(dirname "$0")"
name="$1"
dur="$2"
python3 audio/mix.py --events "$name.events.json" --dur "$dur" --out "$name"
ffmpeg -v error -y -i "$name.mp4" -i "$name.mix.wav" \
  -af "loudnorm=I=-19:TP=-1.5:LRA=11" -c:v copy -c:a aac -b:a 256k -ar 48000 -shortest \
  -movflags +faststart "$name.final.mp4"
echo "成片：$name.final.mp4"

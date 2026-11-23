#!/bin/bash
# 把 App 装到 /Applications 并启动（可以重复执行，会先退掉旧实例）
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="CoursePilotStats"
TARGET="/Applications/$APP_NAME.app"

if [ ! -d "dist/$APP_NAME.app" ]; then
  echo "先编译…"
  ./build.sh
fi

pkill -x "$APP_NAME" 2>/dev/null || true
rm -rf "$TARGET"
cp -R "dist/$APP_NAME.app" "$TARGET"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
open "$TARGET"

echo "已安装到 $TARGET"
echo "如果之前开过「开机自启」，请在新位置的菜单里重新勾一次（登录项记的是旧路径）。"

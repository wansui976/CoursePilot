#!/bin/bash
# 编译 CoursePilotStats.app
set -euo pipefail
cd "$(dirname "$0")"

APP="dist/CoursePilotStats.app"
BIN="$APP/Contents/MacOS/CoursePilotStats"
SDK="$(xcrun --show-sdk-path)"
CACHE="$(pwd)/build/ModuleCache"
mkdir -p "$CACHE"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> 编译 (arm64)"
swiftc -O -swift-version 5 -parse-as-library \
  -sdk "$SDK" -target arm64-apple-macos13.0 \
  -module-cache-path "$CACHE" \
  -o build/CoursePilotStats-arm64 \
  Sources/*.swift

EXEC="build/CoursePilotStats-arm64"

# 有 Intel SDK 支持的话顺手编一个通用二进制，方便发给别人
if swiftc -O -swift-version 5 -parse-as-library \
  -sdk "$SDK" -target x86_64-apple-macos13.0 \
  -module-cache-path "$CACHE" \
  -o build/CoursePilotStats-x86_64 \
  Sources/*.swift 2>build/x86_64.log; then
  echo "==> 合并为通用二进制"
  lipo -create -output "$BIN" build/CoursePilotStats-arm64 build/CoursePilotStats-x86_64
else
  echo "==> 跳过 x86_64（仅 Apple Silicon）"
  cp build/CoursePilotStats-arm64 "$BIN"
fi

chmod +x "$BIN"
cp Info.plist "$APP/Contents/Info.plist"
if [ -f AppIcon.icns ]; then
  cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
fi

# 本地自签名就够了，不需要开发者账号
codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1 || echo "!! 自签名失败（一般不影响运行）"

echo "==> 完成: $APP"
lipo -info "$BIN" 2>/dev/null || true

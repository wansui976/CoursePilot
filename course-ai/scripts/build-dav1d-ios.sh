#!/usr/bin/env bash
# 为 iOS 交叉编译 dav1d 静态库（AV1 软解），产物给端上转码用。
#
# 为什么需要手动跑一次：静态库 1.3MB，按仓库对二进制的惯例不入库（见 .gitignore）。
# 头文件已在 vendor/dav1d/include，这里只补 lib/{iphoneos,iphonesimulator}/libdav1d.a。
# CI 的 iOS 构建也先跑它（.github/workflows/build-check.yml、ios-release.yml）。
#
# 依赖：brew install meson ninja
# 用法：course-ai/scripts/build-dav1d-ios.sh [--force]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT_DIR/src-tauri/gen/apple/vendor/dav1d"
WORK="${TMPDIR:-/tmp}/courseai-dav1d"
VERSION="${DAV1D_VERSION:-1.5.4}"

LIBS=("$VENDOR/lib/iphoneos/libdav1d.a" "$VENDOR/lib/iphonesimulator/libdav1d.a")
if [[ "${1:-}" != "--force" && -f "${LIBS[0]}" && -f "${LIBS[1]}" ]]; then
  echo "已存在 ${LIBS[*]}（--force 可重建）"
  exit 0
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1：brew install $1" >&2; exit 1; }; }
need meson
need ninja
need git
need xcrun

mkdir -p "$WORK" "$VENDOR/include"
if [[ ! -d "$WORK/dav1d-src" ]]; then
  git clone --depth 1 --branch "$VERSION" https://code.videolan.org/videolan/dav1d.git "$WORK/dav1d-src"
fi

# 真机与模拟器各编一份，按 Xcode 的 $(PLATFORM_NAME) 分目录放：
# 工程里链接路径写的是 vendor/dav1d/lib/$(PLATFORM_NAME)，模拟器构建（CI 就是）才链得上。
build() {
  local sdk="$1" min_flag="$2"
  cat > "$WORK/$sdk-arm64.txt" <<CROSS
[binaries]
c = ['xcrun', '-sdk', '$sdk', 'clang']
ar = 'ar'
strip = 'strip'
pkgconfig = 'false'

[host_machine]
system = 'darwin'
cpu_family = 'aarch64'
cpu = 'arm64'
endian = 'little'

[properties]
needs_exe_wrapper = true

[built-in options]
c_args = ['-arch', 'arm64', '$min_flag=17.0']
c_link_args = ['-arch', 'arm64', '$min_flag=17.0']
CROSS

  rm -rf "$WORK/build-$sdk"
  meson setup "$WORK/build-$sdk" "$WORK/dav1d-src" \
    --cross-file "$WORK/$sdk-arm64.txt" \
    --default-library=static \
    -Denable_tools=false -Denable_tests=false -Denable_examples=false -Denable_docs=false
  ninja -C "$WORK/build-$sdk"
  mkdir -p "$VENDOR/lib/$sdk"
  cp "$WORK/build-$sdk/src/libdav1d.a" "$VENDOR/lib/$sdk/"
}

build iphoneos -miphoneos-version-min
build iphonesimulator -mios-simulator-version-min

# 头文件一并向上游对齐（首次入库后一般不用再动）。
rm -rf "$VENDOR/include/dav1d"
cp -R "$WORK/dav1d-src/include/dav1d" "$VENDOR/include/"

echo "完成：${LIBS[*]}"

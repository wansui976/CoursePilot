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

# whisper-cli（本地转写）：whisper.cpp 没有 macOS 的命令行预编译包，从源码编。
# 与 Windows 用同一个版本（prepare-windows-sidecars.ps1 里的 b5454），参数行为一致。
# - 静态链接、（Apple 芯片版的）Metal 着色器嵌进二进制：只依赖系统框架，拷进 .app 就能用；
# - GGML_NATIVE=OFF：不按构建机的 CPU 特性编，换台机器也能跑；
# - Intel 版不开 Metal：ggml 的 Metal 后端只对 Apple 芯片的 GPU 调过，Intel 核显 / AMD 独显上
#   会报错或出乱码，走 CPU。指令集按 AVX2 + FMA + F16C 编——macOS 14 支持的 Intel Mac（2018 年起）
#   都有，不开 AVX-512（大多数机型没有）；
# - 最低系统版本与应用一致（tauri.macos.conf.json 的 minimumSystemVersion）。
#   Homebrew 的 whisper-cpp 是按构建机系统版本编的，在更老的 macOS 上会拒绝启动，不能直接拷。
# 产物旁边留一个版本戳：同版本已经编过（本机重跑、CI 命中缓存）就跳过。
WHISPER_CPP_TAG="${WHISPER_CPP_TAG:-b5454}"
MACOS_MIN_VERSION="14.0"
whisper="$binary_dir/whisper-cli-$target"
whisper_stamp="$binary_dir/.whisper-cli-$target.tag"
if [[ -x "$whisper" && "$(cat "$whisper_stamp" 2>/dev/null)" == "$WHISPER_CPP_TAG@$MACOS_MIN_VERSION" ]]; then
  echo "whisper-cli $WHISPER_CPP_TAG already built, skipping"
else
  whisper_src="$(mktemp -d)/whisper.cpp"
  echo "Building whisper-cli $WHISPER_CPP_TAG for $target (macOS >= $MACOS_MIN_VERSION)"
  git clone --quiet --depth 1 --branch "$WHISPER_CPP_TAG" https://github.com/ggml-org/whisper.cpp.git "$whisper_src"
  case "$target" in
    aarch64-apple-darwin)
      whisper_arch_flags=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)
      ;;
    x86_64-apple-darwin)
      whisper_arch_flags=(-DGGML_METAL=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON)
      ;;
  esac
  cmake -S "$whisper_src" -B "$whisper_src/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_MIN_VERSION" \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    "${whisper_arch_flags[@]}" \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=OFF \
    -DWHISPER_SDL2=OFF \
    -DWHISPER_CURL=OFF
  cmake --build "$whisper_src/build" --target whisper-cli --config Release -j "$(sysctl -n hw.ncpu)"
  cp "$whisper_src/build/bin/whisper-cli" "$whisper"
  rm -rf "$whisper_src"
  chmod 755 "$whisper"
  xattr -c "$whisper" 2>/dev/null || true
  codesign --force --sign - "$whisper"
  echo "$WHISPER_CPP_TAG@$MACOS_MIN_VERSION" > "$whisper_stamp"
fi

# 打进安装包前确认：只链接系统库（/usr/lib、/System），最低系统版本对得上。
non_system_libs="$(otool -L "$whisper" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/)' || true)"
if [[ -n "$non_system_libs" ]]; then
  echo "whisper-cli links non-system libraries, it would break on users' machines:" >&2
  echo "$non_system_libs" >&2
  exit 1
fi
whisper_minos="$(otool -l "$whisper" | awk '/LC_BUILD_VERSION/{found=1} found && /minos/{print $2; exit}')"
if [[ "$whisper_minos" != "$MACOS_MIN_VERSION" ]]; then
  echo "whisper-cli minimum macOS is $whisper_minos, expected $MACOS_MIN_VERSION" >&2
  exit 1
fi

# sherpa-onnx 动态库（本地中文识别 SenseVoice / Qwen3-ASR）：Rust 绑定构建时自己下一份链接用，这里再取
# 同一版本的官方包打进 .app 的 Contents/Frameworks（tauri.macos.conf.json 的 frameworks，build.rs 加了
# 对应的 rpath）。版本必须和 Cargo.lock 里的 sherpa-onnx-sys 一致，否则运行时符号对不上。
SHERPA_ONNX_VERSION="2.0.1"
locked_sherpa="$(awk '/^name = "sherpa-onnx-sys"$/ { getline; gsub(/version = |"/, ""); print }' "$repo_root/course-ai/src-tauri/Cargo.lock")"
if [[ "$locked_sherpa" != "$SHERPA_ONNX_VERSION" ]]; then
  echo "Cargo.lock 里 sherpa-onnx-sys 是 $locked_sherpa，这里打包的是 $SHERPA_ONNX_VERSION：两边要一起升级" >&2
  exit 1
fi
case "$target" in
  aarch64-apple-darwin)
    sherpa_asset="sherpa-onnx-v$SHERPA_ONNX_VERSION-osx-arm64-shared-lib"
    sherpa_sha256="e2d57ad9c83803d6c48f259caa66e44879bd4c4724c61f0d51a277b411bffb1d"
    ;;
  x86_64-apple-darwin)
    sherpa_asset="sherpa-onnx-v$SHERPA_ONNX_VERSION-osx-x64-shared-lib"
    sherpa_sha256="be9042971c5d1b14da76a960534d2a8cdb6f0e5e02f5e1dc8bddff8576359bdd"
    ;;
esac
sherpa_dir="$binary_dir/sherpa-onnx"
echo "Downloading $sherpa_asset"
curl -L --fail --retry 5 --retry-delay 3 --retry-all-errors \
  -o "$binary_dir/$sherpa_asset.tar.bz2" \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$SHERPA_ONNX_VERSION/$sherpa_asset.tar.bz2"
echo "$sherpa_sha256  $binary_dir/$sherpa_asset.tar.bz2" | shasum -a 256 -c -
rm -rf "$sherpa_dir" "$binary_dir/$sherpa_asset"
tar -xjf "$binary_dir/$sherpa_asset.tar.bz2" -C "$binary_dir"
mkdir -p "$sherpa_dir"
cp "$binary_dir/$sherpa_asset/lib/libsherpa-onnx-c-api.dylib" "$binary_dir/$sherpa_asset/lib/libonnxruntime.dylib" "$sherpa_dir/"
rm -rf "$binary_dir/$sherpa_asset" "$binary_dir/$sherpa_asset.tar.bz2"
for lib in "$sherpa_dir"/*.dylib; do
  xattr -c "$lib" 2>/dev/null || true
  codesign --force --sign - "$lib"
done
# 链接也用这份库：Rust 绑定自己下的那份放在 target/sherpa-onnx-prebuilt，CI 的 rust-cache 不缓存它，
# 而缓存回来的构建记录又让它的构建脚本不再重跑——链接时就找不到库（LNK1181 / ld 找不到 -lsherpa-onnx-c-api）。
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "SHERPA_ONNX_LIB_DIR=$sherpa_dir" >> "$GITHUB_ENV"
fi

echo "Prepared macOS sidecars:"
"$ffmpeg" -version | sed -n '1,2p'
"$ytdlp" --version
"$whisper" --help 2>&1 | sed -n '1,2p'
ls -lh "$ffmpeg" "$ytdlp" "$whisper" "$sherpa_dir"/*.dylib

$ErrorActionPreference = "Stop"

$repoRoot = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { Resolve-Path "$PSScriptRoot\..\.." }
$binaryDir = Join-Path $repoRoot "course-ai\src-tauri\binaries"
$tempDir = Join-Path $env:RUNNER_TEMP "coursepilot-sidecars"
$target = "x86_64-pc-windows-msvc"

New-Item -ItemType Directory -Force -Path $binaryDir | Out-Null
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

function Download-File {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$OutFile
  )
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -MaximumRedirection 10
}

function Copy-FirstMatch {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Pattern,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $match = Get-ChildItem -Path $Root -Filter $Pattern -Recurse | Select-Object -First 1
  if (-not $match) {
    throw "Could not find $Pattern under $Root"
  }
  Copy-Item $match.FullName $Destination -Force
}

# ffmpeg
$ffmpegZip = Join-Path $tempDir "ffmpeg.zip"
$ffmpegOut = Join-Path $tempDir "ffmpeg"
Download-File "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip" $ffmpegZip
Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegOut -Force
Copy-FirstMatch $ffmpegOut "ffmpeg.exe" (Join-Path $binaryDir "ffmpeg-$target.exe")

# yt-dlp
Download-File "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" (Join-Path $binaryDir "yt-dlp-$target.exe")

# llama-server（本地识别 Qwen3-ASR 用的引擎，llama.cpp）：官方的 Windows Vulkan 预编译包。
# Vulkan 在 NVIDIA、AMD、Intel 显卡上都能用，显卡驱动自带运行库，用户不用装 CUDA。
# CPU 后端按指令集拆成多个 ggml-cpu-*.dll、Vulkan 后端单独一个 ggml-vulkan.dll，运行时按需加载：
# 没有 Vulkan 驱动的机器加载 Vulkan 后端失败，照样用 CPU 跑。
# 只拷识别要用的文件（llama-server 和它加载的库），其余几十个命令行工具不要。
# 与 macOS 用同一个版本（prepare-macos-sidecars.sh 的 LLAMA_CPP_TAG）。升级时一起改版本号和哈希。
$llamaTag = if ($env:LLAMA_CPP_TAG) { $env:LLAMA_CPP_TAG } else { "b12167" }
$llamaSha256 = "f99b2fc83d93f4a36778e5966600c8a4a36e8a3a6660521601317c02f974ca9d"
$llamaZip = Join-Path $tempDir "llama.zip"
$llamaOut = Join-Path $tempDir "llama"
Download-File "https://github.com/ggml-org/llama.cpp/releases/download/$llamaTag/llama-$llamaTag-bin-win-vulkan-x64.zip" $llamaZip
if (-not $env:LLAMA_CPP_TAG) {
  $actual = (Get-FileHash -Algorithm SHA256 $llamaZip).Hash.ToLower()
  if ($actual -ne $llamaSha256) {
    throw "llama.cpp $llamaTag zip SHA-256 mismatch: $actual"
  }
}
Expand-Archive -Path $llamaZip -DestinationPath $llamaOut -Force
Copy-FirstMatch $llamaOut "llama-server.exe" (Join-Path $binaryDir "llama-server-$target.exe")
Get-ChildItem -Path $llamaOut -Filter "*.dll" -Recurse |
  Where-Object { $_.Name -notmatch '^llama-.+-impl\.dll$' -or $_.Name -eq 'llama-server-impl.dll' } |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $binaryDir $_.Name) -Force }
foreach ($required in @("llama-server-impl.dll", "llama.dll", "mtmd.dll", "ggml.dll", "ggml-base.dll", "ggml-vulkan.dll", "ggml-cpu-x64.dll")) {
  if (-not (Test-Path (Join-Path $binaryDir $required))) {
    throw "llama.cpp package is missing $required"
  }
}

# 打进安装包的原生程序是 MSVC 编的，依赖 VC++ 运行库（还有 OpenMP 的 vcomp140）。
# 干净的 Windows 默认没装运行库，程序一启动就报 0xc0000135（找不到 DLL）。
# 从 runner 上 Visual Studio 的可再发行目录拷 x64 版本，和 exe 放在一起。
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vsRoot = & $vswhere -latest -products * -property installationPath
$redistRoot = Get-ChildItem -Path (Join-Path $vsRoot "VC\Redist\MSVC") -Directory |
  Where-Object { $_.Name -match '^\d+\.\d+' } |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1
if (-not $redistRoot) {
  throw "MSVC redist directory not found under $vsRoot"
}
$crtDir = Get-ChildItem -Path (Join-Path $redistRoot.FullName "x64") -Directory -Filter "Microsoft.VC14*.CRT" | Select-Object -First 1
$ompDir = Get-ChildItem -Path (Join-Path $redistRoot.FullName "x64") -Directory -Filter "Microsoft.VC14*.OpenMP" | Select-Object -First 1
foreach ($dll in @(
    (Join-Path $crtDir.FullName "msvcp140.dll"),
    (Join-Path $crtDir.FullName "vcruntime140.dll"),
    (Join-Path $crtDir.FullName "vcruntime140_1.dll"),
    (Join-Path $ompDir.FullName "vcomp140.dll")
  )) {
  if (-not (Test-Path $dll)) {
    throw "MSVC runtime DLL not found: $dll"
  }
  Copy-Item $dll $binaryDir -Force
}

# Tesseract OCR. Install on the runner, then bundle the runtime files we need.
choco install tesseract --yes --no-progress
$tesseractRoot = "C:\Program Files\Tesseract-OCR"
if (-not (Test-Path $tesseractRoot)) {
  throw "Tesseract install path not found: $tesseractRoot"
}
Copy-Item (Join-Path $tesseractRoot "tesseract.exe") (Join-Path $binaryDir "tesseract-$target.exe") -Force
Get-ChildItem -Path $tesseractRoot -Filter "*.dll" | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $binaryDir $_.Name) -Force
}
$tessdataOut = Join-Path $binaryDir "tessdata"
New-Item -ItemType Directory -Force -Path $tessdataOut | Out-Null
foreach ($lang in @("eng", "chi_sim")) {
  $trainedData = Join-Path $tesseractRoot "tessdata\$lang.traineddata"
  if (Test-Path $trainedData) {
    Copy-Item $trainedData $tessdataOut -Force
  } elseif ($lang -eq "chi_sim") {
    Download-File "https://github.com/tesseract-ocr/tessdata_fast/raw/main/chi_sim.traineddata" (Join-Path $tessdataOut "chi_sim.traineddata")
  } else {
    Write-Warning "Missing $trainedData"
  }
}

# sherpa-onnx 动态库（本地中文识别 SenseVoice / Qwen3-ASR）：DLL 放在 binaries/ 下，由
# tauri.windows.conf.json 的 "binaries/*.dll" 装到 exe 旁边。版本要和 Cargo.lock 里的 sherpa-onnx-sys 一致。
$sherpaVersion = "2.0.1"
$cargoLock = Join-Path $repoRoot "course-ai\src-tauri\Cargo.lock"
$lockedSherpa = (Select-String -Path $cargoLock -Pattern '^name = "sherpa-onnx-sys"$' -Context 0,1).Context.PostContext[0] -replace 'version = |"', ''
if ($lockedSherpa -ne $sherpaVersion) {
  throw "Cargo.lock 里 sherpa-onnx-sys 是 $lockedSherpa，这里打包的是 $sherpaVersion：两边要一起升级"
}
$sherpaAsset = "sherpa-onnx-v$sherpaVersion-win-x64-shared-MT-Release-lib"
$sherpaArchive = Join-Path $tempDir "$sherpaAsset.tar.bz2"
Download-File "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaVersion/$sherpaAsset.tar.bz2" $sherpaArchive
$sherpaHash = (Get-FileHash -Algorithm SHA256 $sherpaArchive).Hash.ToLower()
if ($sherpaHash -ne "afa4de3ca4ab0afd53bb4aab40d28ee15608364b549ffc0fe0caf6489bfc39a5") {
  throw "sherpa-onnx archive hash mismatch: $sherpaHash"
}
$sherpaOut = Join-Path $tempDir "sherpa-onnx"
New-Item -ItemType Directory -Force -Path $sherpaOut | Out-Null
tar -xjf $sherpaArchive -C $sherpaOut
# binaries/sherpa-onnx 放整个 lib 目录（链接要 .lib 导入库，运行要 .dll），DLL 另拷一份到 binaries/ 下打进安装包。
$sherpaLib = Join-Path $binaryDir "sherpa-onnx"
if (Test-Path $sherpaLib) { Remove-Item -Recurse -Force $sherpaLib }
Copy-Item -Recurse (Join-Path $sherpaOut "$sherpaAsset\lib") $sherpaLib
Get-ChildItem -Path $sherpaLib -Filter "*.dll" | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $binaryDir $_.Name) -Force
}
# 链接也用这份库：Rust 绑定自己下的那份在 target/sherpa-onnx-prebuilt，CI 的 rust-cache 不缓存它，
# 缓存回来的构建记录又让它的构建脚本不再重跑——链接时就找不到 sherpa-onnx-c-api.lib（LNK1181）。
if ($env:GITHUB_ENV) {
  "SHERPA_ONNX_LIB_DIR=$sherpaLib" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}

Write-Host "Prepared sidecars:"
Get-ChildItem -Path $binaryDir -Recurse | Select-Object FullName, Length

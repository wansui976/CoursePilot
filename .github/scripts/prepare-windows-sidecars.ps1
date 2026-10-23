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

# whisper.cpp
$whisperZip = Join-Path $tempDir "whisper.zip"
$whisperOut = Join-Path $tempDir "whisper"
# 固定版本：whisper.cpp 自 v1.9.3 起把预编译包发在 bNNNN 构建版里，打了 vX.Y.Z 的
# 「latest」release 没有资产，latest/download 会 404。升级时把这里换成新的构建号。
$whisperTag = if ($env:WHISPER_CPP_TAG) { $env:WHISPER_CPP_TAG } else { "b5454" }
Download-File "https://github.com/ggml-org/whisper.cpp/releases/download/$whisperTag/whisper-bin-x64.zip" $whisperZip
Expand-Archive -Path $whisperZip -DestinationPath $whisperOut -Force
Copy-FirstMatch $whisperOut "whisper-cli.exe" (Join-Path $binaryDir "whisper-cli-$target.exe")
Get-ChildItem -Path $whisperOut -Filter "*.dll" -Recurse | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $binaryDir $_.Name) -Force
}

# whisper.cpp 的预编译包是 MSVC 编的，依赖 VC++ 运行库（ggml-base 还要 OpenMP 的 vcomp140）。
# 干净的 Windows 默认没装运行库，whisper-cli 一启动就报 0xc0000135（找不到 DLL），
# 本地转写整个不可用。从 runner 上 Visual Studio 的可再发行目录拷 x64 版本，和 exe 放在一起。
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

Write-Host "Prepared sidecars:"
Get-ChildItem -Path $binaryDir -Recurse | Select-Object FullName, Length

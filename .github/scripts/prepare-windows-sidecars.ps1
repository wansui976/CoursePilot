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
Download-File "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip" $whisperZip
Expand-Archive -Path $whisperZip -DestinationPath $whisperOut -Force
Copy-FirstMatch $whisperOut "whisper-cli.exe" (Join-Path $binaryDir "whisper-cli-$target.exe")
Get-ChildItem -Path $whisperOut -Filter "*.dll" -Recurse | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $binaryDir $_.Name) -Force
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

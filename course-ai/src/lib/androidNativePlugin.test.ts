import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pluginSourcePath = join(
  process.cwd(),
  "src-tauri/gen/android/app/src/main/java/dev/courseai/mobilefiles/MobileFilesPlugin.kt",
);
const iosPluginSourcePath = join(
  process.cwd(),
  "src-tauri/ios/Sources/MobileFilesPlugin.swift",
);
const androidBuildPath = join(process.cwd(), "src-tauri/gen/android/app/build.gradle.kts");

function commandBody(source: string, commandName: string) {
  const start = source.indexOf(`fun ${commandName}(invoke: Invoke)`);
  expect(start).toBeGreaterThanOrEqual(0);

  const braceStart = source.indexOf("{", start);
  expect(braceStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(braceStart + 1, index);
    }
  }

  throw new Error(`Could not parse ${commandName} body`);
}

describe("Android native plugin threading", () => {
  it("runs ASR audio export off the Android main thread", () => {
    const source = readFileSync(pluginSourcePath, "utf8");
    const body = commandBody(source, "exportAudioForAsr");

    const backgroundStart = body.indexOf("runOnIoThread");
    const exportStart = body.indexOf("val export =");

    expect(backgroundStart).toBeGreaterThanOrEqual(0);
    expect(exportStart).toBeGreaterThan(backgroundStart);
  });

  it("runs frame capture off the Android main thread", () => {
    const source = readFileSync(pluginSourcePath, "utf8");
    const body = commandBody(source, "exportFrameJpeg");

    const backgroundStart = body.indexOf("runOnIoThread");
    const captureStart = body.indexOf("readFrameBitmap");

    expect(backgroundStart).toBeGreaterThanOrEqual(0);
    expect(captureStart).toBeGreaterThan(backgroundStart);
  });

  it("keeps mobile (Android + iOS) slide extraction enabled in the Rust pipeline", () => {
    const source = readFileSync(
      join(process.cwd(), "src-tauri/src/pipeline/slides.rs"),
      "utf8",
    );

    // 课件提取现已对 Android 与 iOS 同时启用：共用原生亮度抽帧 + 同一套换页检测。
    expect(source).toContain("sample_mobile_luma_frames");
    expect(source).toContain("export_luma_frames");
    expect(source).toContain(
      'cfg(any(target_os = "android", target_os = "ios"))',
    );
    expect(source).not.toContain("移动端暂不支持课件自动抽取");
  });

  it("uses native frame capture for Android OCR screenshots", () => {
    const source = readFileSync(
      join(process.cwd(), "src-tauri/src/pipeline/ocr.rs"),
      "utf8",
    );

    expect(source).toContain("#[cfg(target_os = \"android\")]");
    expect(source).toContain("slides::capture_frame");
    expect(source).toContain("recognize_image_text");
    expect(source).not.toContain("移动端 OCR 暂不可用");
  });

  it("runs bundled ML Kit OCR off the Android main thread", () => {
    const source = readFileSync(pluginSourcePath, "utf8");
    const build = readFileSync(androidBuildPath, "utf8");
    const body = commandBody(source, "recognizeImageText");

    expect(build).toContain('com.google.mlkit:text-recognition-chinese:16.0.1');
    expect(body.indexOf("runOnIoThread")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("ChineseTextRecognizerOptions")).toBeGreaterThan(
      body.indexOf("runOnIoThread"),
    );
    expect(body).toContain("Tasks.await");
  });
});

describe("Apple Vision OCR", () => {
  it("keeps all Vision objects inside the blocking thread", () => {
    const pipeline = readFileSync(
      join(process.cwd(), "src-tauri/src/pipeline/ocr.rs"),
      "utf8",
    );
    const vision = readFileSync(
      join(process.cwd(), "src-tauri/src/pipeline/apple_vision.rs"),
      "utf8",
    );

    expect(pipeline).toContain("spawn_blocking");
    expect(vision).toContain("VNRecognizeTextRequest::new()");
    expect(vision).toContain('["zh-Hans", "en-US"]');
    expect(vision).toContain("autoreleasepool");
  });
});

describe("iOS native plugin audio export", () => {
  it("writes WAV samples on a separate queue to avoid blocking the export queue", () => {
    const source = readFileSync(iosPluginSourcePath, "utf8");

    expect(source).toContain("audioWriterQueue");
    expect(source).toContain("requestMediaDataWhenReady(on: audioWriterQueue)");
    expect(source).not.toContain("requestMediaDataWhenReady(on: workQueue)");
  });

  it("exports ASR WAV as 16 kHz mono PCM", () => {
    const source = readFileSync(iosPluginSourcePath, "utf8");

    expect(source).toContain("AVSampleRateKey: 16000");
    expect(source).toContain("AVNumberOfChannelsKey: 1");
    expect(source).toContain("audio/wav");
    expect(source).toContain("\"format\": result.format");
  });
});

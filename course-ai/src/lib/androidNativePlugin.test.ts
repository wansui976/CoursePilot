import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pluginSourcePath = join(
  process.cwd(),
  "src-tauri/gen/android/app/src/main/java/dev/courseai/mobilefiles/MobileFilesPlugin.kt",
);

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

  it("keeps Android slide extraction enabled in the Rust pipeline", () => {
    const source = readFileSync(
      join(process.cwd(), "src-tauri/src/pipeline/slides.rs"),
      "utf8",
    );

    expect(source).toContain("sample_android_luma_frames");
    expect(source).toContain("export_luma_frames");
    expect(source).not.toContain("移动端暂不支持自动提取课件，请在桌面端生成后同步");
  });

  it("uses native frame capture for Android OCR screenshots", () => {
    const source = readFileSync(
      join(process.cwd(), "src-tauri/src/pipeline/ocr.rs"),
      "utf8",
    );

    expect(source).toContain("#[cfg(target_os = \"android\")]");
    expect(source).toContain("slides::capture_frame");
    expect(source).toContain("移动端本地 Tesseract OCR 不可用");
  });
});

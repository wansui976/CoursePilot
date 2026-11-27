import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");

function readAppleProjectConfig() {
  return readFileSync(
    resolve(projectRoot, "src-tauri/gen/apple/project.yml"),
    "utf8",
  );
}

describe("iOS project config", () => {
  it("allows localhost HTTP for the media server used by video playback", () => {
    const project = readAppleProjectConfig();

    expect(project).toContain("NSAppTransportSecurity:");
    expect(project).toContain("NSAllowsLocalNetworking: true");
  });

  it("declares background audio so picture in picture keeps playing on the home screen", () => {
    const project = readAppleProjectConfig();
    expect(project).toMatch(/UIBackgroundModes:\n\s+- audio\n/);
    const plist = readFileSync(
      resolve(projectRoot, "src-tauri/gen/apple/course-ai_iOS/Info.plist"),
      "utf8",
    );
    expect(plist).toMatch(/<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>/);
  });
});

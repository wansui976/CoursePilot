import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tauri capabilities", () => {
  it("allows Android picked files to be persisted under app data", () => {
    const capabilityPath = resolve("src-tauri/capabilities/default.json");
    const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
      permissions: Array<string | { identifier: string }>;
    };

    expect(capability.permissions).toContain("fs:default");
    expect(capability.permissions).toContain("fs:allow-appdata-write-recursive");
    expect(capability.permissions).toContain("mobile-files:default");
  });
});

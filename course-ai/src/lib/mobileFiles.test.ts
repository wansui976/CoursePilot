import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { copyFileMock, invokeMock, mkdirMock } = vi.hoisted(() => ({
  copyFileMock: vi.fn(),
  invokeMock: vi.fn(),
  mkdirMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/data/user/0/dev.courseai.app.debug"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
  BaseDirectory: { AppData: 15 },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  copyFile: copyFileMock,
  mkdir: mkdirMock,
}));

describe("persistPickedFile", () => {
  beforeEach(() => {
    vi.resetModules();
    copyFileMock.mockReset();
    invokeMock.mockReset();
    mkdirMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the Android mobile plugin for content URIs", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    invokeMock.mockResolvedValue(
      "/data/user/0/dev.courseai.app.debug/picked/cookies/cookies.txt",
    );

    const { persistPickedFile } = await import("./mobileFiles");
    const result = await persistPickedFile(
      "content://com.android.providers.downloads.documents/document/42",
      "cookies",
      "cookies.txt",
    );

    expect(result).toBe(
      "/data/user/0/dev.courseai.app.debug/picked/cookies/cookies.txt",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:mobile-files|persist_picked_file",
      {
        sourceUri: "content://com.android.providers.downloads.documents/document/42",
        category: "cookies",
        fallbackName: "cookies.txt",
      },
    );
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
  });
});

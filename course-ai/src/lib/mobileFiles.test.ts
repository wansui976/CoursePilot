import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appDataDirMock, copyFileMock, invokeMock, joinMock, mkdirMock, openMock } = vi.hoisted(() => ({
  appDataDirMock: vi.fn(),
  copyFileMock: vi.fn(),
  invokeMock: vi.fn(),
  joinMock: vi.fn(),
  mkdirMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: appDataDirMock,
  join: joinMock,
  BaseDirectory: { AppData: 15 },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  copyFile: copyFileMock,
  mkdir: mkdirMock,
}));

describe("persistPickedFile", () => {
  beforeEach(() => {
    vi.resetModules();
    appDataDirMock.mockReset();
    copyFileMock.mockReset();
    invokeMock.mockReset();
    joinMock.mockReset();
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

  it("uses the iOS mobile plugin so Photos picker files are persisted natively", async () => {
    vi.stubGlobal("navigator", { userAgent: "iPhone" });
    invokeMock.mockResolvedValue(
      "/private/var/mobile/Containers/Data/Application/APP/Library/Application Support/picked/videos/clip.mov",
    );

    const { persistPickedFile } = await import("./mobileFiles");
    const result = await persistPickedFile(
      "/private/var/mobile/Containers/Shared/AppGroup/file.mov",
      "videos",
      "clip.mov",
    );

    expect(result).toBe(
      "/private/var/mobile/Containers/Data/Application/APP/Library/Application Support/picked/videos/clip.mov",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:mobile-files|persist_picked_file",
      {
        sourceUri: "/private/var/mobile/Containers/Shared/AppGroup/file.mov",
        category: "videos",
        fallbackName: "clip.mov",
      },
    );
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
  });
});

describe("mobileCategoryDir", () => {
  beforeEach(() => {
    vi.resetModules();
    appDataDirMock.mockReset();
    joinMock.mockReset();
    mkdirMock.mockReset();
    appDataDirMock.mockResolvedValue("/data/user/0/dev.courseai.app.debug");
    joinMock.mockImplementation(async (...parts: string[]) => parts.join("/"));
    mkdirMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a category directory inside app data on iOS", async () => {
    vi.stubGlobal("navigator", { userAgent: "iPhone" });

    const { mobileCategoryDir } = await import("./mobileFiles");
    const result = await mobileCategoryDir("videos");

    expect(result).toBe("/data/user/0/dev.courseai.app.debug/videos");
    expect(mkdirMock).toHaveBeenCalledWith(
      "/data/user/0/dev.courseai.app.debug/videos",
      { recursive: true },
    );
  });
});

describe("pickDirectoryPath", () => {
  beforeEach(() => {
    vi.resetModules();
    appDataDirMock.mockReset();
    copyFileMock.mockReset();
    invokeMock.mockReset();
    joinMock.mockReset();
    mkdirMock.mockReset();
    openMock.mockReset();
    appDataDirMock.mockResolvedValue("/data/user/0/dev.courseai.app.debug");
    joinMock.mockImplementation(async (...parts: string[]) => parts.join("/"));
    mkdirMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses an app-data directory on Android without opening a picker", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });

    const { pickDirectoryPath } = await import("./mobileFiles");
    const result = await pickDirectoryPath(["courses", "新课程"]);

    expect(result).toBe("/data/user/0/dev.courseai.app.debug/courses/新课程");
    expect(openMock).not.toHaveBeenCalled();
    expect(mkdirMock).toHaveBeenCalledWith(
      "/data/user/0/dev.courseai.app.debug/courses/新课程",
      { recursive: true },
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "plugin:mobile-files|resolve_picked_directory",
      expect.anything(),
    );
  });

  it("uses an app-data directory on iOS without opening a picker", async () => {
    vi.stubGlobal("navigator", { userAgent: "iPhone" });

    const { pickDirectoryPath } = await import("./mobileFiles");
    const result = await pickDirectoryPath(["courses", "新课程"]);

    expect(result).toBe("/data/user/0/dev.courseai.app.debug/courses/新课程");
    expect(openMock).not.toHaveBeenCalled();
    expect(mkdirMock).toHaveBeenCalledWith(
      "/data/user/0/dev.courseai.app.debug/courses/新课程",
      { recursive: true },
    );
  });

  it("uses an app-data directory on iPadOS desktop-class user agents", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });

    const { pickDirectoryPath } = await import("./mobileFiles");
    const result = await pickDirectoryPath(["courses", "新课程"]);

    expect(result).toBe("/data/user/0/dev.courseai.app.debug/courses/新课程");
    expect(openMock).not.toHaveBeenCalled();
    expect(mkdirMock).toHaveBeenCalledWith(
      "/data/user/0/dev.courseai.app.debug/courses/新课程",
      { recursive: true },
    );
  });
});

describe("pickPersistedFile", () => {
  beforeEach(() => {
    vi.resetModules();
    appDataDirMock.mockReset();
    copyFileMock.mockReset();
    invokeMock.mockReset();
    joinMock.mockReset();
    mkdirMock.mockReset();
    openMock.mockReset();
    appDataDirMock.mockResolvedValue("/data/user/0/dev.courseai.app.debug");
    joinMock.mockImplementation(async (...parts: string[]) => parts.join("/"));
    mkdirMock.mockResolvedValue(undefined);
    copyFileMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the document picker for fallback file selection", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });
    openMock.mockResolvedValue("/Users/me/Downloads/clip.mov");

    const { pickPersistedFile } = await import("./mobileFiles");
    const result = await pickPersistedFile({
      category: "videos",
      fallbackName: "video.mp4",
      filters: [{ name: "Video", extensions: ["mp4", "mov"] }],
    });

    expect(result).toEqual({ path: "/Users/me/Downloads/clip.mov", durationMs: null });
    expect(openMock).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      pickerMode: "document",
      filters: [{ name: "Video", extensions: ["mp4", "mov"] }],
    });
  });
});

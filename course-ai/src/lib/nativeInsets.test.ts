import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isAndroidMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isAndroidMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/platform", () => ({ isAndroid: isAndroidMock }));

import { applyNativeInsets } from "./nativeInsets";

describe("applyNativeInsets", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isAndroidMock.mockReset();
  });

  it("writes Android system bar insets into CSS variables", async () => {
    isAndroidMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ top: 24, right: 0, bottom: 48, left: 0 });
    const el = document.createElement("div");

    await applyNativeInsets(el);

    expect(invokeMock).toHaveBeenCalledWith("plugin:mobile-files|system_bar_insets");
    expect(el.style.getPropertyValue("--native-inset-top")).toBe("24px");
    expect(el.style.getPropertyValue("--native-inset-bottom")).toBe("48px");
  });

  it("does nothing outside Android, and survives a failing bridge", async () => {
    const el = document.createElement("div");
    isAndroidMock.mockReturnValue(false);
    await applyNativeInsets(el);
    expect(invokeMock).not.toHaveBeenCalled();

    isAndroidMock.mockReturnValue(true);
    invokeMock.mockRejectedValue(new Error("no plugin"));
    await expect(applyNativeInsets(el)).resolves.toBeUndefined();
    expect(el.style.getPropertyValue("--native-inset-bottom")).toBe("");
  });
});

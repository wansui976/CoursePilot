import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { RemoteSyncStatus } from "@/lib/ipc";
import { RemoteSyncSection } from "./RemoteSyncSection";

const { mockIpc, mockConfirm } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockIpc: {
    remoteSync: {
      status: vi.fn(),
      test: vi.fn(),
      save: vi.fn(),
      setEnabled: vi.fn(),
      now: vi.fn(),
      nudge: vi.fn(),
      retireDevice: vi.fn(),
    },
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mockConfirm }));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

function status(overrides: Partial<RemoteSyncStatus> = {}): RemoteSyncStatus {
  return {
    enabled: false,
    url: "",
    folder: "CoursePilot",
    user: "",
    hasPassword: false,
    deviceId: "d1",
    deviceName: "Windows",
    pending: 0,
    devices: [],
    state: { running: false, lastSuccessAt: null, lastError: null, lastReport: null },
    uploadMedia: false,
    media: { uploading: null, lastError: null },
    ...overrides,
  };
}

describe("RemoteSyncSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    for (const fn of Object.values(mockIpc.remoteSync)) fn.mockReset().mockResolvedValue(undefined);
  });

  it("没配好之前不能开同步；填齐后保存并测试，密码不回显", async () => {
    mockIpc.remoteSync.status.mockResolvedValue(status());
    mockIpc.remoteSync.test.mockResolvedValue(1);
    render(<RemoteSyncSection />);

    // 坚果云的地址默认填好。
    expect(await screen.findByDisplayValue("https://dav.jianguoyun.com/dav/")).toBeInTheDocument();
    expect(screen.getByText("先填好网盘并保存")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "开启同步" }));
    expect(mockIpc.remoteSync.setEnabled).not.toHaveBeenCalled();

    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("账号"), { target: { value: " me@example.com " } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "app-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("已连上 · 网盘上已有 1 台设备")).toBeInTheDocument();
    const draft = { url: "https://dav.jianguoyun.com/dav/", folder: "CoursePilot", user: "me@example.com", password: "app-pass" };
    expect(mockIpc.remoteSync.test).toHaveBeenCalledWith(draft);

    fireEvent.click(save);
    await waitFor(() => expect(mockIpc.remoteSync.save).toHaveBeenCalledWith(draft));
    await waitFor(() => expect(screen.getByLabelText("密码")).toHaveValue(""));
  });

  it("开着时显示上次同步、待上传条数和其它设备，可以立即同步", async () => {
    const now = Date.now();
    mockIpc.remoteSync.status.mockResolvedValue(
      status({
        enabled: true,
        url: "https://dav.jianguoyun.com/dav/",
        user: "me",
        hasPassword: true,
        pending: 3,
        devices: [{ deviceId: "d2", name: "安卓", platform: "android", seenAt: now - 60_000 }],
        state: { running: false, lastSuccessAt: now - 120_000, lastError: null, lastReport: null },
      }),
    );
    mockIpc.remoteSync.now.mockResolvedValue({ pushed: 3, pulled: 0, applied: 0, parked: 0, pending: 0 });
    render(<RemoteSyncSection />);

    expect(await screen.findByText("还有 3 条改动等着上传")).toBeInTheDocument();
    expect(screen.getByText("安卓")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即同步" }));
    await waitFor(() => expect(mockIpc.remoteSync.now).toHaveBeenCalled());
  });

  it("移除另一台设备前先确认，取消就什么都不做", async () => {
    mockIpc.remoteSync.status.mockResolvedValue(
      status({
        enabled: true,
        url: "https://dav.jianguoyun.com/dav/",
        user: "me",
        hasPassword: true,
        devices: [{ deviceId: "old-phone", name: "旧手机", platform: "android", seenAt: Date.now() - 90 * 86_400_000 }],
      }),
    );
    mockIpc.remoteSync.retireDevice.mockResolvedValue(undefined);
    render(<RemoteSyncSection />);
    const button = await screen.findByRole("button", { name: "移除设备「旧手机」" });

    mockConfirm.mockResolvedValueOnce(false);
    fireEvent.click(button);
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockIpc.remoteSync.retireDevice).not.toHaveBeenCalled();

    mockConfirm.mockResolvedValueOnce(true);
    fireEvent.click(button);
    await waitFor(() => expect(mockIpc.remoteSync.retireDevice).toHaveBeenCalledWith("old-phone"));
    expect(String(mockConfirm.mock.calls[1][0])).toContain("不会丢");
  });
});

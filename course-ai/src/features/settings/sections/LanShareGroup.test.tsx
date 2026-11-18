import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { LanShareStatus } from "@/lib/ipc";
import { LanShareGroup } from "./LanShareGroup";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: { lanShare: { status: vi.fn(), setEnabled: vi.fn() } },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

const off: LanShareStatus = { supported: true, enabled: false, running: false, port: null, addresses: [], error: null };

describe("LanShareGroup", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
  });

  it("电脑上可以打开，打开后显示局域网地址", async () => {
    mockIpc.lanShare.status.mockResolvedValue(off);
    mockIpc.lanShare.setEnabled.mockResolvedValue({ ...off, enabled: true, running: true, port: 47321, addresses: ["192.168.1.5"] });
    render(<LanShareGroup />);
    const toggle = await screen.findByRole("switch", { name: "让同一 Wi‑Fi 下的设备直接播放这台电脑上的视频" });
    fireEvent.click(toggle);
    await waitFor(() => expect(mockIpc.lanShare.setEnabled).toHaveBeenCalledWith(true));
    expect(await screen.findByText("已打开 · 192.168.1.5")).toBeInTheDocument();
  });

  it("打开失败（端口、证书）时说明原因", async () => {
    mockIpc.lanShare.status.mockResolvedValue({ ...off, enabled: true, error: "Address already in use" });
    render(<LanShareGroup />);
    expect(await screen.findByText(/Address already in use/)).toBeInTheDocument();
  });

  it("手机上没有开关，只说明在电脑上打开", async () => {
    mockIpc.lanShare.status.mockResolvedValue({ ...off, supported: false });
    render(<LanShareGroup />);
    expect(await screen.findByText(/在电脑上的「设置 → 多设备同步」里打开/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});

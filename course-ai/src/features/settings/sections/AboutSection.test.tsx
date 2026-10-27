import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkUpdate } = vi.hoisted(() => ({ checkUpdate: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { app: { checkUpdate } } }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.3.4") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { resetAutoCheckForTests, useUpdate } from "@/lib/updateCheck";
import { useTours } from "@/stores/tours";
import { AboutSection } from "./AboutSection";

describe("AboutSection", () => {
  beforeEach(() => {
    localStorage.clear();
    checkUpdate.mockReset();
    useUpdate.setState({ result: null, ignored: null });
    resetAutoCheckForTests();
  });

  it("显示当前版本，手动检查后说清有没有新版本", async () => {
    render(<AboutSection />);
    expect(await screen.findByText("0.3.4")).toBeInTheDocument();

    checkUpdate.mockResolvedValueOnce({ current: "0.3.4", latest: "0.3.4", newer: false, url: "u" });
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("已是最新版本")).toBeInTheDocument();

    checkUpdate.mockResolvedValueOnce({ current: "0.3.4", latest: "0.3.5", newer: true, url: "u" });
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText(/有新版本 0\.3\.5/)).toBeInTheDocument();
    // 手动查到的新版本，首页的提示也跟着出现。
    expect(useUpdate.getState().result?.latest).toBe("0.3.5");
  });

  it("检查失败时说明原因", async () => {
    checkUpdate.mockRejectedValueOnce(new Error("check update: error sending request: dns error"));
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText(/检查失败/)).toBeInTheDocument();
  });

  it("自动检查默认开着，关掉后记住", () => {
    render(<AboutSection />);
    const toggle = screen.getByRole("switch", { name: "自动检查新版本" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("course-ai-update-auto")).toBe("0");
  });

  it("可以让新手引导重新出现", () => {
    render(<AboutSection />);
    expect(useTours.getState().seen.size).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "重新显示" }));
    expect(useTours.getState().seen.size).toBe(0);
    expect(screen.getByText("已重置，打开对应页面时会再出现")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新显示" })).toBeDisabled();
  });
});

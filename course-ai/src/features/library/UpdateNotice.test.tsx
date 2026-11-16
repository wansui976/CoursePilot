import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkUpdate, updaterCheck, updaterInstall, openUrl, progress } = vi.hoisted(() => ({
  checkUpdate: vi.fn(),
  updaterCheck: vi.fn(),
  updaterInstall: vi.fn(),
  openUrl: vi.fn(),
  progress: { emit: null as null | ((payload: unknown) => void) },
}));
vi.mock("@/lib/ipc", () => ({ ipc: { app: { checkUpdate, updaterCheck, updaterInstall } } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    progress.emit = (payload) => handler({ payload });
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.3.4") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { resetAutoCheckForTests, useUpdate } from "@/lib/updateCheck";
import { UpdateNotice } from "./UpdateNotice";

const RELEASE_PAGE = "https://github.com/wansui976/CoursePilot/releases/tag/v0.3.5";

describe("UpdateNotice", () => {
  beforeEach(() => {
    localStorage.clear();
    checkUpdate.mockReset();
    updaterCheck.mockReset().mockResolvedValue(null);
    updaterInstall.mockReset();
    openUrl.mockReset();
    useUpdate.setState({ result: null, ignored: null });
    resetAutoCheckForTests();
  });

  it("有新版本时提示，点「查看更新」打开发布页", async () => {
    checkUpdate.mockResolvedValue({ current: "0.3.4", latest: "0.3.5", newer: true, url: RELEASE_PAGE });
    render(<UpdateNotice />);

    expect(await screen.findByText("CoursePilot 0.3.5 已发布")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看更新" }));
    expect(openUrl).toHaveBeenCalledWith(RELEASE_PAGE);
  });

  it("「不再提示这个版本」之后就不显示了，下次启动也不显示", async () => {
    checkUpdate.mockResolvedValue({ current: "0.3.4", latest: "0.3.5", newer: true, url: RELEASE_PAGE });
    const { unmount } = render(<UpdateNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "不再提示这个版本" }));
    expect(screen.queryByText("CoursePilot 0.3.5 已发布")).not.toBeInTheDocument();
    expect(localStorage.getItem("course-ai-update-ignored")).toBe("0.3.5");

    unmount();
    resetAutoCheckForTests();
    render(<UpdateNotice />);
    await vi.waitFor(() => expect(checkUpdate).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("已是最新版本时什么都不显示", async () => {
    checkUpdate.mockResolvedValue({ current: "0.3.4", latest: "0.3.4", newer: false, url: RELEASE_PAGE });
    render(<UpdateNotice />);
    await vi.waitFor(() => expect(checkUpdate).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("有签过名的更新包时给「立即更新」：下载有进度，装完重启", async () => {
    checkUpdate.mockResolvedValue({ current: "0.3.4", latest: "0.3.5", newer: true, url: RELEASE_PAGE });
    updaterCheck.mockResolvedValue({ version: "0.3.5", current: "0.3.4" });
    let finish!: () => void;
    updaterInstall.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<UpdateNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "立即更新" }));
    await waitFor(() => expect(updaterInstall).toHaveBeenCalled());
    progress.emit?.({ downloaded: 25, total: 100 });
    expect(await screen.findByText("正在下载 25%")).toBeInTheDocument();
    finish();
  });

  it("没有更新包（旧版本发布、网络不通）时只留「查看更新」", async () => {
    checkUpdate.mockResolvedValue({ current: "0.3.4", latest: "0.3.5", newer: true, url: RELEASE_PAGE });
    updaterCheck.mockRejectedValue(new Error("no latest.json"));
    render(<UpdateNotice />);
    expect(await screen.findByRole("button", { name: "查看更新" })).toBeInTheDocument();
    await waitFor(() => expect(updaterCheck).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
  });

  it("自动更新失败时说清楚，还能去发布页手动下载", async () => {
    checkUpdate.mockResolvedValue({ current: "0.3.4", latest: "0.3.5", newer: true, url: RELEASE_PAGE });
    updaterCheck.mockResolvedValue({ version: "0.3.5", current: "0.3.4" });
    updaterInstall.mockRejectedValue(new Error("signature mismatch"));
    render(<UpdateNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "立即更新" }));
    expect(await screen.findByText(/自动更新没成功/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看更新" })).toBeEnabled();
  });
});

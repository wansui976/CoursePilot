import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkUpdate, openUrl } = vi.hoisted(() => ({
  checkUpdate: vi.fn(),
  openUrl: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { app: { checkUpdate } } }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.3.4") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { resetAutoCheckForTests, useUpdate } from "@/lib/updateCheck";
import { UpdateNotice } from "./UpdateNotice";

const RELEASE_PAGE = "https://github.com/wansui976/CoursePilot/releases/tag/v0.3.5";

describe("UpdateNotice", () => {
  beforeEach(() => {
    localStorage.clear();
    checkUpdate.mockReset();
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
});

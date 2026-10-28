import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ErrorNote } from "./ErrorNote";
import { ShellContext, type Shell } from "@/app/shell";

describe("ErrorNote localization", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("renders the error guidance and retry action in English", async () => {
    await i18n.changeLanguage("en");
    const retry = vi.fn();

    render(<ErrorNote error="timed out" onRetry={retry} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The request timed out. Check your network and retry.",
    );
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText("重试")).not.toBeInTheDocument();
  });
});

describe("ErrorNote 配置类报错", () => {
  it("在外壳里给出「去配置大模型」，点了打开对应设置分类", () => {
    const openSettingsCategory = vi.fn();
    const shell = { openSettingsCategory } as unknown as Shell;
    render(
      <ShellContext.Provider value={shell}>
        <ErrorNote error="尚未配置可用的大模型（设置 → 大模型）" />
      </ShellContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "去配置大模型" }));
    expect(openSettingsCategory).toHaveBeenCalledWith("llm");
  });

  it("不在外壳里、或不是配置问题时不显示", () => {
    const { unmount } = render(<ErrorNote error="尚未配置可用的大模型" />);
    expect(screen.queryByRole("button", { name: "去配置大模型" })).not.toBeInTheDocument();
    unmount();
    render(
      <ShellContext.Provider value={{ openSettingsCategory: vi.fn() } as unknown as Shell}>
        <ErrorNote error="timed out" />
      </ShellContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: /去配置/ })).not.toBeInTheDocument();
  });
});

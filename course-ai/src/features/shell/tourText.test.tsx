import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { richText } from "./tourText";

describe("richText", () => {
  it("renders <code> and <link> and leaves the rest as text", () => {
    render(<p>{richText("在 <link>DeepSeek 开放平台</link> 注册，填 <code>https://api.deepseek.com</code>。", "https://platform.deepseek.com/")}</p>);
    expect(screen.getByText("https://api.deepseek.com").tagName).toBe("CODE");
    fireEvent.click(screen.getByRole("button", { name: "DeepSeek 开放平台" }));
    expect(openUrl).toHaveBeenCalledWith("https://platform.deepseek.com/");
    expect(screen.getByRole("paragraph")).toHaveTextContent("在 DeepSeek 开放平台 注册，填 https://api.deepseek.com。");
  });

  it("drops the link markup when there is no url", () => {
    render(<p>{richText("看 <link>这里</link>")}</p>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("paragraph")).toHaveTextContent("看 这里");
  });
});

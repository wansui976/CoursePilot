import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { renderInlineMarkdown, renderMarkdown } from "./renderMarkdown";

function renderMd(md: string, onSeek = vi.fn()) {
  return render(<div data-testid="root">{renderMarkdown(md, onSeek)}</div>);
}

describe("renderMarkdown", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("renders fenced code blocks verbatim, without lists, timestamps or math inside", () => {
    const md = "看这段：\n\n```python\n- not a list\nprint('[12:34]', 2 * $x$)\n\n# not a heading\n```\n\n之后";
    const { container } = renderMd(md);
    const code = container.querySelector("pre > code")!;
    expect(code).toHaveAttribute("data-lang", "python");
    expect(code.textContent).toBe("- not a list\nprint('[12:34]', 2 * $x$)\n\n# not a heading");
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelector("h1")).toBeNull();
    expect(screen.queryByRole("button", { name: /12:34/ })).toBeNull();
    expect(screen.getByText("之后")).toBeInTheDocument();
  });

  it("shows an unclosed fence as code while it is still streaming", () => {
    const { container } = renderMd("```js\nconst a = 1;\nconst b");
    expect(container.querySelector("pre > code")?.textContent).toBe("const a = 1;\nconst b");
  });

  it("copies a code block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderMd("```\nls -la\n```");
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    expect(writeText).toHaveBeenCalledWith("ls -la");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("renders `inline code` literally", () => {
    const { container } = renderMd("运行 `**a** 12:34 $x$` 即可");
    const code = container.querySelector("p code")!;
    expect(code.textContent).toBe("**a** 12:34 $x$");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("renders **bold** as <strong>", () => {
    const { getByText } = renderMd("这是**重点**内容");
    const strong = getByText("重点");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders bullet lists as <ul><li>", () => {
    const { container } = renderMd("- 第一点\n- 第二点");
    const items = container.querySelectorAll("ul > li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("第一点");
  });

  it("renders numbered lists as <ol><li>", () => {
    const { container } = renderMd("1. 甲\n2. 乙\n3. 丙");
    expect(container.querySelectorAll("ol > li")).toHaveLength(3);
  });

  it("preserves markdown heading levels as semantic headings", () => {
    const { container, getByText } = renderMd("# 一级\n### 三级\n###### 六级");
    expect(container.querySelector("h1")).toHaveTextContent("一级");
    expect(container.querySelector("h3")).toHaveTextContent("三级");
    expect(container.querySelector("h6")).toHaveTextContent("六级");
    expect(getByText("三级").className).toContain("font-semibold");
  });

  it("keeps KaTeX math and clickable timestamps working inside markdown", () => {
    const onSeek = vi.fn();
    const { container } = renderMd(
      "- 公式 \\(E=mc^2\\) 在 [00:05]",
      onSeek,
    );
    // 公式经 KaTeX 渲染。
    expect(container.querySelector(".katex")).not.toBeNull();
    // 时间戳渲染成可点击按钮。
    const tsBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("00:05"),
    );
    expect(tsBtn).toBeDefined();
    tsBtn!.click();
    expect(onSeek).toHaveBeenCalled();
  });

  it("appends trailing node to the last block only", () => {
    const { container } = renderMd("");
    expect(container.querySelectorAll("[data-testid='caret']")).toHaveLength(0);
    const { getAllByTestId } = render(
      <div>
        {renderMarkdown("第一段\n\n第二段", vi.fn(), (
          <span data-testid="caret" />
        ))}
      </div>,
    );
    expect(getAllByTestId("caret")).toHaveLength(1);
  });

  it("groups consecutive trailing timestamps as quiet paragraph sources", () => {
    const onSeek = vi.fn();
    renderMd(
      "核心结论。 [00:05] [00:18] [01:02]",
      onSeek,
    );

    const sources = screen.getByRole("group", { name: "来源" });
    expect(sources).toHaveTextContent("来源");
    expect(sources).not.toHaveTextContent("▶");
    expect(
      Array.from(sources.querySelectorAll("button")).every(
        (button) => !button.classList.contains("bg-primary/15"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "跳转到 00:18" }));
    expect(onSeek).toHaveBeenCalledWith(18_000);
  });

  it("keeps a single timestamp inline", () => {
    renderMd("核心结论 [00:05]");

    expect(screen.queryByRole("group", { name: "来源" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /00:05/ })).toHaveTextContent("▶");
  });

  it("localizes source labels and jump actions", async () => {
    await i18n.changeLanguage("en");
    const onSeek = vi.fn();
    renderMd("Conclusion. [00:05] [00:18]", onSeek);

    expect(screen.getByRole("group", { name: "Sources" })).toHaveTextContent("Sources");
    fireEvent.click(screen.getByRole("button", { name: "Jump to 00:18" }));
    expect(onSeek).toHaveBeenCalledWith(18_000);
  });

  it("merges consecutive > lines into one blockquote with inline formatting", () => {
    const { container } = renderMd("正文\n\n> 直觉：**下山**\n> 每步朝最陡处");
    const quotes = container.querySelectorAll("blockquote");
    expect(quotes).toHaveLength(1);
    // 两行合成同一个引用块（toHaveTextContent 会把换行折成空格）。
    expect(quotes[0]).toHaveTextContent("直觉：下山 每步朝最陡处");
    expect(quotes[0].querySelector("strong")).toHaveTextContent("下山");
    expect(container.textContent).not.toContain(">");
  });
});

describe("renderInlineMarkdown", () => {
  it("renders bold without wrapping the text in block elements", () => {
    const { container } = render(<div>{renderInlineMarkdown("会来回**震荡**")}</div>);
    expect(container.querySelector("strong")).toHaveTextContent("震荡");
    expect(container.querySelector("p, ul, blockquote")).toBeNull();
    expect(container.textContent).toBe("会来回震荡");
  });
});

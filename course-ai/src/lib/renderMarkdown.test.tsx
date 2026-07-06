import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { renderMarkdown } from "./renderMarkdown";

function renderMd(md: string, onSeek = vi.fn()) {
  return render(<div data-testid="root">{renderMarkdown(md, onSeek)}</div>);
}

describe("renderMarkdown", () => {
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

  it("renders headings as emphasized text", () => {
    const { getByText } = renderMd("## 小标题");
    expect(getByText("小标题").className).toContain("font-semibold");
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
});

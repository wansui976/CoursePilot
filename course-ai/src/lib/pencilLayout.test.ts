import { describe, expect, it } from "vitest";
import { findQuoteRange, stackTops } from "./pencilLayout";

describe("pencil layout", () => {
  it("finds a quote across bold and plain text nodes", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>学习率<strong>太大</strong>：在谷底两侧来回震荡</p>";
    const range = findQuoteRange(root, "太大：在谷底");
    expect(range?.toString()).toBe("太大：在谷底");
    expect(findQuoteRange(root, "没有这句")).toBeNull();
  });

  it("pushes overlapping notes down", () => {
    expect(stackTops([10, 12, 100], [30, 30, 30])).toEqual([10, 48, 100]);
  });
});

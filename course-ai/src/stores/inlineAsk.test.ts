import { beforeEach, describe, expect, it } from "vitest";
import { useInlineAsk } from "./inlineAsk";

describe("useInlineAsk", () => {
  beforeEach(() => useInlineAsk.setState({ pending: null }));

  it("stores the selected text and timestamp, trimming whitespace", () => {
    useInlineAsk.getState().askAbout("  贝叶斯定理  ", 5000);
    expect(useInlineAsk.getState().pending).toEqual({
      text: "贝叶斯定理",
      startMs: 5000,
    });
  });

  it("ignores an empty / whitespace-only selection", () => {
    useInlineAsk.getState().askAbout("   ", 0);
    expect(useInlineAsk.getState().pending).toBeNull();
  });

  it("clears the pending context once consumed", () => {
    useInlineAsk.getState().askAbout("x", null);
    useInlineAsk.getState().clear();
    expect(useInlineAsk.getState().pending).toBeNull();
  });
});

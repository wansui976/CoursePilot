import { describe, expect, it } from "vitest";
import { estimatePrintPages } from "./printPages";

describe("estimatePrintPages", () => {
  it("fits a short note on one page", () => {
    expect(estimatePrintPages({ contentHeight: 300, textWidth: 400, fontPx: 14.4 })).toEqual({ pages: 1, breaks: [] });
  });

  it("breaks a long note into pages at increasing heights", () => {
    const estimate = estimatePrintPages({ contentHeight: 4000, textWidth: 400, fontPx: 14.4 });
    expect(estimate.pages).toBeGreaterThan(1);
    expect(estimate.breaks).toHaveLength(estimate.pages - 1);
    expect(estimate.breaks.every((y, i) => i === 0 || y > estimate.breaks[i - 1])).toBe(true);
    expect(estimate.breaks[estimate.breaks.length - 1]).toBeLessThan(4000);
  });

  it("a narrower column wraps into more lines, so fewer pages", () => {
    const wide = estimatePrintPages({ contentHeight: 4000, textWidth: 600, fontPx: 14.4 });
    const narrow = estimatePrintPages({ contentHeight: 4000, textWidth: 300, fontPx: 14.4 });
    expect(narrow.pages).toBeLessThanOrEqual(wide.pages);
  });

  it("returns nothing for an empty editor", () => {
    expect(estimatePrintPages({ contentHeight: 0, textWidth: 400, fontPx: 14.4 }).pages).toBe(0);
  });
});

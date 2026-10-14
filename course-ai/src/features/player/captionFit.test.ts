import { describe, expect, it } from "vitest";
import { fitCaptionFontSize } from "./captionFit";

const zh = "接下来看随机梯度下降：每次只用一个小批量估计梯度。";
const en = "Next, stochastic gradient descent: estimate the gradient from a mini-batch each step.";

describe("fitCaptionFontSize", () => {
  it("keeps the height-based size when the text fits on one line", () => {
    // 宽舞台（桌面）：与原先只按高度算的结果一致。
    const heightOnly = fitCaptionFontSize({ boxWidthPx: 0, boxHeightPx: 100, primary: zh });
    const withWidth = fitCaptionFontSize({ boxWidthPx: 1200, boxHeightPx: 100, primary: zh });
    expect(withWidth).toBe(heightOnly);
  });

  it("shrinks a bilingual caption whose translation would wrap on a narrow stage", () => {
    const loose = fitCaptionFontSize({ boxWidthPx: 0, boxHeightPx: 60, primary: zh, translation: en });
    const narrow = fitCaptionFontSize({ boxWidthPx: 320, boxHeightPx: 60, primary: zh, translation: en });
    expect(narrow).toBeLessThan(loose);
    expect(narrow).toBeGreaterThanOrEqual(10);
  });

  it("never goes below the readable floor", () => {
    expect(fitCaptionFontSize({ boxWidthPx: 120, boxHeightPx: 20, primary: zh, translation: en })).toBe(10);
    expect(fitCaptionFontSize({ boxWidthPx: 120, boxHeightPx: 20, primary: zh })).toBe(12);
  });
});

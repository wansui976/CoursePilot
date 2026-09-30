import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
} from "./assistant";

describe("assistant ui store", () => {
  it("宽度夹在可读区间内", () => {
    expect(clampPanelWidth(0)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(Number.NaN)).toBeLessThanOrEqual(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(99999)).toBe(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(420)).toBe(420);
  });
});

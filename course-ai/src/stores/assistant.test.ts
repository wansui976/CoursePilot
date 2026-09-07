import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  DEFAULT_ASSISTANT_MODE,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
} from "./assistant";

describe("assistant ui store", () => {
  it("没有历史偏好时默认停靠为侧栏", () => {
    // 停靠是 IDE 式助手的主形态：全高、不挡内容。浮球是收起后的入口，不是第一印象。
    expect(DEFAULT_ASSISTANT_MODE).toBe("docked");
  });

  it("宽度夹在可读区间内", () => {
    expect(clampPanelWidth(0)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(Number.NaN)).toBeLessThanOrEqual(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(99999)).toBe(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(420)).toBe(420);
  });
});

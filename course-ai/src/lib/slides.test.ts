import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_SENSITIVITY,
  DEFAULT_SLIDES_SENSITIVITY,
  getSlidesSensitivity,
  sensitivityToThreshold,
  setSlidesSensitivity,
} from "./slides";

describe("slides sensitivity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("maps sensitivity to a per-block luminance threshold", () => {
    // 灵敏度越高、门槛越低、抓的页越多。
    expect(sensitivityToThreshold(100)).toBe(4);
    expect(sensitivityToThreshold(0)).toBe(24);
    expect(sensitivityToThreshold(DEFAULT_SLIDES_SENSITIVITY)).toBe(14);
    expect(sensitivityToThreshold(100)).toBeLessThan(sensitivityToThreshold(0) as number);
  });

  it("lets auto hand the decision to the backend", () => {
    // null 一路传到后端，触发按画面噪声自估门槛。
    expect(sensitivityToThreshold(AUTO_SENSITIVITY)).toBeNull();
  });

  it("persists both a manual level and auto", () => {
    expect(getSlidesSensitivity()).toBe(DEFAULT_SLIDES_SENSITIVITY);
    setSlidesSensitivity(80);
    expect(getSlidesSensitivity()).toBe(80);
    setSlidesSensitivity(AUTO_SENSITIVITY);
    expect(getSlidesSensitivity()).toBe(AUTO_SENSITIVITY);
    // 坏数据（旧版写入的空串等）回落到默认档，而不是变成 NaN 门槛。
    localStorage.setItem("slides-sensitivity", "");
    expect(getSlidesSensitivity()).toBe(DEFAULT_SLIDES_SENSITIVITY);
  });
});

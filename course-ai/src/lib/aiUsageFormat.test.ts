import { describe, expect, it } from "vitest";
import { currencyFor, formatCost, formatPricePerMillion, toUsd, USD_TO_CNY } from "./aiUsageFormat";

describe("大模型花费的货币", () => {
  it("中文界面用人民币，英文界面用美元", () => {
    expect(currencyFor("zh-CN")).toBe("CNY");
    expect(currencyFor("en")).toBe("USD");
    expect(formatCost(1, "zh-CN")).toBe(`¥${USD_TO_CNY.toFixed(2)}`);
    expect(formatCost(1, "en")).toBe("$1.00");
    expect(formatCost(0, "zh-CN")).toBe("¥0.00");
  });

  it("不到一分时给四位小数", () => {
    expect(formatCost(0.0001, "zh-CN")).toBe(`¥${(0.0001 * USD_TO_CNY).toFixed(4)}`);
    expect(formatCost(0.001, "en")).toBe("$0.0010");
  });

  it("每百万 token 的参考价也跟着换", () => {
    expect(formatPricePerMillion(0.3, "en")).toBe("$0.30");
    expect(formatPricePerMillion(0.3, "zh-CN")).toBe(`¥${(0.3 * USD_TO_CNY).toFixed(2)}`);
    expect(formatPricePerMillion(0, "zh-CN")).toBe("¥0");
    expect(formatPricePerMillion(null, "zh-CN")).toBeNull();
  });

  it("人民币预算折回美元存", () => {
    expect(toUsd(USD_TO_CNY * 10, "CNY")).toBeCloseTo(10);
    expect(toUsd(10, "USD")).toBe(10);
  });
});

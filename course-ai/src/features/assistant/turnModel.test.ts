import { describe, expect, it } from "vitest";
import { bracketBareTimestamps } from "./turnModel";

describe("bracketBareTimestamps", () => {
  it("把裸写的时间点补成可点的方括号形式", () => {
    expect(bracketBareTimestamps("出现在 11:04，停留到 12:30。")).toBe(
      "出现在 [11:04]，停留到 [12:30]。",
    );
    expect(bracketBareTimestamps("1. 03:00 讲梯度方向")).toBe("1. [03:00] 讲梯度方向");
    expect(bracketBareTimestamps("见 1:02:03")).toBe("见 [1:02:03]");
    expect(bracketBareTimestamps("11:04–12:30")).toBe("[11:04]–[12:30]");
  });

  it("已经带方括号的、比分比例、超出时钟范围的都不动", () => {
    expect(bracketBareTimestamps("见 [11:04] 和 [1:02:03]")).toBe("见 [11:04] 和 [1:02:03]");
    expect(bracketBareTimestamps("比分 3:2，比例 16:9")).toBe("比分 3:2，比例 16:9");
    expect(bracketBareTimestamps("12:75")).toBe("12:75");
    expect(bracketBareTimestamps("123:45")).toBe("123:45");
  });
});

import { describe, expect, it } from "vitest";
import { solarTermDay, solarTermOn } from "./solarTerms";

describe("solar terms", () => {
  it("lands on the published dates", () => {
    expect(solarTermDay(2026, "立冬")).toBe(7);
    expect(solarTermDay(2026, "冬至")).toBe(22);
    expect(solarTermDay(2026, "立春")).toBe(4);
    expect(solarTermDay(2025, "清明")).toBe(4);
    expect(solarTermDay(2024, "夏至")).toBe(21);
  });

  it("names the term of the day and nothing on ordinary days", () => {
    expect(solarTermOn(new Date(2026, 10, 7))).toEqual({ name: "立冬", phenology: "水始冰" });
    expect(solarTermOn(new Date(2026, 10, 8))).toBeNull();
  });
});

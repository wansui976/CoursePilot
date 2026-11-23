import { describe, expect, it } from "vitest";
import { moonLitPath, moonPhase } from "./moon";
import { daypartOf, seasonOf } from "./daypart";

describe("moon", () => {
  it("is new at the reference new moon and full half a month later", () => {
    expect(moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14)))).toBeCloseTo(0, 3);
    expect(moonPhase(new Date(Date.UTC(2000, 0, 21, 6, 58)))).toBeCloseTo(0.5, 1);
  });

  it("draws a lit shape for every phase", () => {
    for (const phase of [0.1, 0.25, 0.4, 0.5, 0.6, 0.9]) {
      expect(moonLitPath(phase, 150, 40, 12)).toMatch(/^M 150 28 A 12 12 0 0 [01] 150 52 A [\d.]+ 12 0 0 [01] 150 28 Z$/);
    }
  });
});

describe("daypart and season", () => {
  it("follows the real sunrise and sunset when known", () => {
    const sunrise = new Date(2026, 10, 23, 6, 30).getTime();
    const sunset = new Date(2026, 10, 23, 16, 50).getTime();
    const at = (h: number, m: number) => daypartOf(new Date(2026, 10, 23, h, m), { sunrise, sunset });
    expect(at(6, 0)).toBe("dawn");
    expect(at(12, 0)).toBe("day");
    expect(at(16, 30)).toBe("dusk");
    expect(at(18, 0)).toBe("night");
    // 没有日出日落时按固定钟点：17:30 算黄昏。
    expect(daypartOf(new Date(2026, 10, 23, 17, 30))).toBe("dusk");
  });

  it("knows the season, flipped south of the equator", () => {
    expect(seasonOf(new Date(2026, 10, 23))).toBe("autumn");
    expect(seasonOf(new Date(2026, 10, 23), -33.9)).toBe("spring");
    expect(seasonOf(new Date(2026, 0, 5))).toBe("winter");
  });
});

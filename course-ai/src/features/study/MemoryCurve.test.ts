import { describe, expect, it } from "vitest";
import type { CardHistory } from "@/lib/ipc";
import { curveOf, recall } from "@/lib/memoryCurve";

const DAY = 86_400_000;
const base: CardHistory = {
  card_id: "c",
  front: "Q",
  created_at: 0,
  reviews: [
    { ts: 0, rating: 3, stability: 2 },
    { ts: 3 * DAY, rating: 3, stability: 8 },
  ],
  due_at: 11 * DAY,
  factor: 19 / 81,
  decay: -0.5,
};

describe("memory curve", () => {
  it("uses the backend forgetting curve: 90% recall after S days", () => {
    expect(recall(base, 0, 5)).toBeCloseTo(1);
    expect(recall(base, 5, 5)).toBeCloseTo(0.9, 3);
  });

  it("jumps back to 100% at each review and forecasts to the due date", () => {
    const curve = curveOf(base, 5 * DAY);
    const atSecondReview = curve.past.find((p) => Math.abs(p.day - 3) < 1e-9 && p.r === 1);
    expect(atSecondReview).toBeTruthy();
    expect(curve.future[0].day).toBeCloseTo(5);
    expect(curve.future[curve.future.length - 1].day).toBeCloseTo(11);
    expect(curve.spanDays).toBeCloseTo(11);
  });

  it("is empty before the first review", () => {
    expect(curveOf({ ...base, reviews: [] }, 0).past).toEqual([]);
  });
});

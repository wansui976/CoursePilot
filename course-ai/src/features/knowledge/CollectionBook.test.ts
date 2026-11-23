import { describe, expect, it } from "vitest";
import { cardState } from "@/lib/collection";

describe("collection card state", () => {
  it("is a silhouette until the concept has cards", () => {
    expect(cardState(undefined)).toBe("locked");
    expect(cardState({ concept_id: "k", cards: 0, reviewed: 0, retention: null })).toBe("locked");
  });

  it("waits to light up until a card has been reviewed", () => {
    expect(cardState({ concept_id: "k", cards: 2, reviewed: 0, retention: null })).toBe("pending");
  });

  it("is lit while remembered and fades below the review threshold", () => {
    expect(cardState({ concept_id: "k", cards: 2, reviewed: 2, retention: 0.93 })).toBe("lit");
    expect(cardState({ concept_id: "k", cards: 2, reviewed: 2, retention: 0.6 })).toBe("fading");
  });
});

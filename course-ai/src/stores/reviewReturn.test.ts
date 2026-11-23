import { beforeEach, describe, expect, it } from "vitest";
import { useReviewReturn } from "./reviewReturn";

describe("useReviewReturn", () => {
  beforeEach(() => useReviewReturn.getState().clear());

  it("hands the session back only after a return was marked", () => {
    useReviewReturn.getState().remember({ kind: "mistakes" }, "v1");
    expect(useReviewReturn.getState().take()).toBeNull();
    expect(useReviewReturn.getState().pending).toBeNull();
  });

  it("resumes the remembered session once, then forgets it", () => {
    useReviewReturn.getState().remember({ kind: "due" }, "v1");
    useReviewReturn.getState().markResume();
    expect(useReviewReturn.getState().take()).toEqual({ kind: "due" });
    expect(useReviewReturn.getState().take()).toBeNull();
  });
});

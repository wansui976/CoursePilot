import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBlackBarCrop } from "./useBlackBarCrop";

describe("useBlackBarCrop", () => {
  it("returns no bars synchronously and never throws in jsdom", () => {
    const { result } = renderHook(() => useBlackBarCrop("asset://fake.mp4"));
    expect(result.current.hasBars).toBe(false);
    expect(result.current.crop).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });
});

import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bucketForWidth, coarsePointer, useContainerWidth } from "./useContainerWidth";

describe("bucketForWidth", () => {
  it("maps width ranges to buckets at the documented breakpoints", () => {
    expect(bucketForWidth(0)).toBe("compact");
    expect(bucketForWidth(599)).toBe("compact");
    expect(bucketForWidth(600)).toBe("medium");
    expect(bucketForWidth(899)).toBe("medium");
    expect(bucketForWidth(900)).toBe("wide");
    expect(bucketForWidth(1440)).toBe("wide");
  });
});

describe("coarsePointer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns true when the pointer:coarse media query matches", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("coarse"),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    expect(coarsePointer()).toBe(true);
  });

  it("returns false when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(coarsePointer()).toBe(false);
  });
});

describe("useContainerWidth", () => {
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it("derives the bucket from window width for a detached ref (jsdom)", () => {
    // detached ref（clientWidth 0/无）→ 回退到窗口宽度;无论 ResizeObserver 是否存在都成立。
    window.innerWidth = 480;
    const { result } = renderHook(() => useContainerWidth(useRef<HTMLDivElement>(null)));
    expect(result.current).toBe("compact");
  });

  it("defaults to wide at a typical desktop width", () => {
    window.innerWidth = 1280;
    const { result } = renderHook(() => useContainerWidth(useRef<HTMLDivElement>(null)));
    expect(result.current).toBe("wide");
  });
});

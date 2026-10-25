import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bucketForWidth,
  coarsePointer,
  useContainerPixelWidth,
  useContainerWidth,
} from "./useContainerWidth";

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

  it("iPad 接了触控板（主指针 fine）时，只要还有触摸屏就仍算触控", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("any-pointer"),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    expect(coarsePointer()).toBe(true);
  });

  it("纯鼠标设备（两个查询都不匹配）不算触控", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    expect(coarsePointer()).toBe(false);
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

describe("useContainerPixelWidth", () => {
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it("falls back to the window width while the container is detached", () => {
    window.innerWidth = 744;
    const { result } = renderHook(() =>
      useContainerPixelWidth(useRef<HTMLDivElement>(null)),
    );
    expect(result.current).toBe(744);
  });

  it("measures the mounted container instead of assuming its width bucket", () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "clientWidth", { value: 612 });

    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(element);
      return useContainerPixelWidth(ref);
    });

    expect(result.current).toBe(612);
  });

  it("subtracts horizontal padding when asked for the content box", () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "clientWidth", { value: 915 });
    element.style.paddingLeft = "52px";
    element.style.paddingRight = "0px";

    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(element);
      return useContainerPixelWidth(ref, { contentBox: true });
    });

    expect(result.current).toBe(863);
  });
});

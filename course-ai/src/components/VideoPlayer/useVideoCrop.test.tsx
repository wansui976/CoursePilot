import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import i18n from "@/i18n";
import { useVideoCrop } from "./useVideoCrop";

const ensureCrop = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  ipc: {
    videos: {
      ensureCrop,
      cancelCropDetect: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function useHarness() {
  const regionRef = useRef<HTMLDivElement>(null);
  return useVideoCrop("v1", regionRef);
}

describe("useVideoCrop", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    localStorage.clear();
    ensureCrop.mockReset();
  });

  it("defaults to auto (on) and applies the detected crop once metadata lands", async () => {
    // 探测到上下各 10% 的信箱黑边。
    ensureCrop.mockResolvedValue({
      insets: { top: 0.1, right: 0, bottom: 0.1, left: 0 },
      detecting: false,
    });
    const { result } = renderHook(() => useHarness(), { wrapper: Wrapper });

    // 默认自动：cropOn 一开始就是 true。
    expect(result.current.cropOn).toBe(true);
    // 画面没到（metadata 未就绪）之前不套裁剪。
    expect(result.current.effectiveCrop.top).toBe(0);

    // 视频元数据就绪 + 画面能放 → 探测查询进场。
    await act(async () => {
      result.current.markMetadata(1920, 1080);
      result.current.markPlayable();
    });

    await waitFor(() => expect(result.current.cropInsets.top).toBe(0.1));
    expect(result.current.effectiveCrop.top).toBeCloseTo(0.1, 5);
    expect(result.current.cropOn).toBe(true);
  });

  it("remembers turning auto-crop off for this video only", async () => {
    ensureCrop.mockResolvedValue({
      insets: { top: 0.1, right: 0, bottom: 0.1, left: 0 },
      detecting: false,
    });
    const { result } = renderHook(() => useHarness(), { wrapper: Wrapper });

    await act(async () => {
      result.current.markMetadata(1920, 1080);
      result.current.markPlayable();
    });
    await waitFor(() => expect(result.current.cropInsets.top).toBe(0.1));

    act(() => result.current.toggleCrop());
    expect(result.current.cropOn).toBe(false);
    expect(localStorage.getItem("crop-black-bars:v1")).toBe("off");
    // 关掉后不再套裁剪。
    expect(result.current.effectiveCrop.top).toBe(0);
  });

  it("treats a video without an override as auto-on even if another video was disabled", async () => {
    // 模拟之前关过别的视频：这个视频没有覆盖，应当仍是默认自动。
    localStorage.setItem("crop-black-bars:v9", "off");
    const { result } = renderHook(() => useHarness(), { wrapper: Wrapper });
    expect(result.current.cropOn).toBe(true);
  });
});

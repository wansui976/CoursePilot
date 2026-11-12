import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionToLibrary, transitionToVideo } from "./viewTransition";

function stubMatchMedia(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce") }));
}

describe("viewTransition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error 测试里临时挂上的 API
    delete document.startViewTransition;
    document.body.innerHTML = "";
  });

  it("引擎不支持 View Transitions 时直接导航", () => {
    stubMatchMedia(false);
    const navigate = vi.fn();
    transitionToVideo("v1", navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("减弱动效时不走过渡", () => {
    stubMatchMedia(true);
    const start = vi.fn();
    document.startViewTransition = start;
    const navigate = vi.fn();
    transitionToVideo("v1", navigate);
    expect(start).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("播放器不在屏上时返回课程库不做过渡", () => {
    stubMatchMedia(false);
    const start = vi.fn();
    document.startViewTransition = start;
    const navigate = vi.fn();
    transitionToLibrary("v1", navigate);
    expect(start).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("支持时在过渡回调里导航，并在结束后摘掉共享元素名", async () => {
    stubMatchMedia(false);
    document.body.innerHTML = `<div data-vt-stage=""></div>`;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let update: (() => Promise<void>) | undefined;
    // @ts-expect-error 测试替身
    document.startViewTransition = (cb: () => Promise<void>) => {
      update = cb;
      return { finished };
    };
    const navigate = vi.fn(() => {
      document.body.innerHTML = "";
    });
    transitionToLibrary(null, navigate);
    const stage = document.querySelector<HTMLElement>("[data-vt-stage]");
    expect(stage?.style.viewTransitionName).toBe("ca-hero");
    expect(document.documentElement.dataset.vtNav).toBe("close");
    await update!();
    expect(navigate).toHaveBeenCalledTimes(1);
    finish();
    await finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.vtNav).toBeUndefined();
    expect(stage?.style.viewTransitionName).toBe("");
  });

  it("startViewTransition 同步抛错时照常导航，并清掉共享元素名", () => {
    stubMatchMedia(false);
    document.body.innerHTML = `<div data-vt-stage=""></div>`;
    document.startViewTransition = () => {
      throw new Error("boom");
    };
    const navigate = vi.fn();
    transitionToLibrary(null, navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
    const stage = document.querySelector<HTMLElement>("[data-vt-stage]");
    expect(stage?.style.viewTransitionName).toBe("");
    expect(document.documentElement.dataset.vtNav).toBeUndefined();
  });

  it("等不到目标 DOM 时按超时放行，不会把导航卡死", async () => {
    vi.useFakeTimers();
    try {
      stubMatchMedia(false);
      document.body.innerHTML = `<div data-vt-stage=""></div>`;
      let update: (() => Promise<void>) | undefined;
      // @ts-expect-error 测试替身：finished 永不落定，只能靠超时兜底
      document.startViewTransition = (cb: () => Promise<void>) => {
        update = cb;
        return { finished: new Promise<void>(() => {}) };
      };
      const navigate = vi.fn();
      transitionToLibrary(null, navigate);
      const pending = update!();
      await vi.advanceTimersByTimeAsync(600);
      await pending;
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("返回课程库前把没有画面轨的 <video> 藏起来（WebKit 拍快照会为它空等 1 秒）", () => {
    stubMatchMedia(false);
    // jsdom 里 <video> 的 videoWidth / videoHeight 恒为 0，正好就是纯音频源的样子。
    document.body.innerHTML = `<div data-vt-stage=""><video></video></div>`;
    const video = document.querySelector("video")!;
    // @ts-expect-error 测试替身
    document.startViewTransition = () => ({ finished: new Promise<void>(() => {}) });
    transitionToLibrary(null, vi.fn());
    expect(video.style.visibility).toBe("hidden");
  });

  it("兜底收尾从动画开始算起：快照拍得慢也不会在动画半途摘掉方向标记", async () => {
    vi.useFakeTimers();
    try {
      stubMatchMedia(false);
      document.body.innerHTML = `<div data-vt-stage=""></div>`;
      let ready!: () => void;
      // @ts-expect-error 测试替身：finished 永不落定，只看兜底计时
      document.startViewTransition = () => ({
        finished: new Promise<void>(() => {}),
        ready: new Promise<void>((resolve) => (ready = resolve)),
      });
      transitionToLibrary(null, vi.fn());
      // 快照花了 1 秒才拍完；旧实现的 1200ms 兜底此时只剩 200ms。
      await vi.advanceTimersByTimeAsync(1000);
      ready();
      await vi.advanceTimersByTimeAsync(600);
      expect(document.documentElement.dataset.vtNav).toBe("close");
      await vi.advanceTimersByTimeAsync(700);
      expect(document.documentElement.dataset.vtNav).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

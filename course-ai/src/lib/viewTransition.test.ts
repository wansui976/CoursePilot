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
});

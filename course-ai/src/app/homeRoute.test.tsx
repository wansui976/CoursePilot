import { act, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { VIEW_PATHS, useHomeRoute, validateHomeSearch } from "./homeRoute";

// 用与 app/router 同构的路由树，但根组件换成探针，避免拉起整个 Home。
async function renderProbe() {
  let api!: ReturnType<typeof useHomeRoute>;
  function Probe() {
    api = useHomeRoute();
    return null;
  }
  const rootRoute = createRootRoute({ component: Probe, validateSearch: validateHomeSearch });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      ...Object.values(VIEW_PATHS).map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path }),
      ),
      createRoute({ getParentRoute: () => rootRoute, path: "/settings/$category" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return { router, current: () => api };
}

describe("useHomeRoute", () => {
  it("starts in the library with nothing selected", async () => {
    const { current } = await renderProbe();
    expect(current()).toMatchObject({ view: "library", courseId: null, videoId: null });
  });

  it("merges consecutive go() calls in the same tick", async () => {
    const { current, router } = await renderProbe();
    act(() => {
      current().go({ courseId: "c1" });
      current().go({ videoId: "v1" });
    });
    expect(current()).toMatchObject({ view: "library", courseId: "c1", videoId: "v1" });
    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps the video session when an overlay view opens and closes", async () => {
    const { current, router } = await renderProbe();
    act(() => current().go({ courseId: "c1", videoId: "v1" }));
    act(() => current().go({ view: "settings" }));
    expect(router.state.location.pathname).toBe("/settings");
    expect(current()).toMatchObject({ view: "settings", courseId: "c1", videoId: "v1" });
    act(() => current().go({ view: "library" }));
    expect(current()).toMatchObject({ view: "library", courseId: "c1", videoId: "v1" });
  });

  it("maps the recycle view to /trash and back", async () => {
    const { current, router } = await renderProbe();
    act(() => current().go({ view: "recycle" }));
    expect(router.state.location.pathname).toBe("/trash");
    expect(current().view).toBe("recycle");
  });

  it("does not push history for a no-op navigation", async () => {
    const { current, router } = await renderProbe();
    act(() => current().go({ courseId: "c1" }));
    const length = router.history.length;
    act(() => current().go({ courseId: "c1" }));
    expect(router.history.length).toBe(length);
  });
});

describe("useHomeRoute settings categories", () => {
  it("drills into a category under /settings and keeps the session", async () => {
    const { current, router } = await renderProbe();
    act(() => current().go({ courseId: "c1", videoId: "v1" }));
    act(() => current().go({ view: "settings", settingsCategory: "llm" }));
    expect(router.state.location.pathname).toBe("/settings/llm");
    expect(current()).toMatchObject({
      view: "settings",
      settingsCategory: "llm",
      courseId: "c1",
      videoId: "v1",
    });

    act(() => current().go({ settingsCategory: null }));
    expect(router.state.location.pathname).toBe("/settings");
    expect(current().view).toBe("settings");
  });

  it("drops the category when leaving settings and re-enters at the root", async () => {
    const { current, router } = await renderProbe();
    act(() => current().go({ view: "settings", settingsCategory: "asr" }));
    act(() => current().go({ view: "library" }));
    expect(current().settingsCategory).toBeNull();

    act(() => current().go({ view: "settings" }));
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("keeps the current category when settings is reopened from inside settings", async () => {
    const { current, router } = await renderProbe();
    act(() => current().go({ view: "settings", settingsCategory: "asr" }));
    act(() => current().go({ view: "settings" }));
    expect(router.state.location.pathname).toBe("/settings/asr");
  });
});

describe("validateHomeSearch", () => {
  it("drops empty and non-string values", () => {
    expect(validateHomeSearch({ course: "", video: 42 })).toEqual({
      course: undefined,
      video: undefined,
    });
  });
});

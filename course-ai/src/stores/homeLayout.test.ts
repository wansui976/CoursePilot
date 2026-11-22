import { beforeEach, describe, expect, it } from "vitest";
import { readHomeLayout, useHomeLayout } from "./homeLayout";

describe("home layout", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to the dashboard", () => {
    expect(readHomeLayout()).toBe("dashboard");
  });

  it("remembers the desk and the expanded deck", () => {
    useHomeLayout.getState().setLayout("desk");
    useHomeLayout.getState().setDeckExpanded(true);
    expect(readHomeLayout()).toBe("desk");
    expect(localStorage.getItem("course-ai-course-deck-expanded")).toBe("1");
    expect(useHomeLayout.getState().layout).toBe("desk");
  });
});

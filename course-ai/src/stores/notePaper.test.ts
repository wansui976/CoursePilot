import { beforeEach, describe, expect, it } from "vitest";
import { useNotePaper } from "./notePaper";

describe("笔记字体", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useNotePaper.setState({ font: "serif" });
  });

  it("默认衬线，选了手写记在本机", () => {
    expect(useNotePaper.getState().font).toBe("serif");
    useNotePaper.getState().setFont("hand");
    expect(useNotePaper.getState().font).toBe("hand");
    expect(window.localStorage.getItem("course-ai-note-font")).toBe("hand");
  });
});

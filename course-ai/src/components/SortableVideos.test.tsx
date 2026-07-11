import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { nextOrder, SortableVideoItem, SortableVideos } from "./SortableVideos";

describe("nextOrder", () => {
  it("moves the dragged id to the drop position", () => {
    expect(nextOrder(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(nextOrder(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns null when nothing actually moves or ids are unknown", () => {
    expect(nextOrder(["a", "b"], "a", "a")).toBeNull();
    expect(nextOrder(["a", "b"], "x", "b")).toBeNull();
    expect(nextOrder(["a", "b"], "a", "x")).toBeNull();
  });
});

describe("SortableVideos", () => {
  it("renders items unchanged inside the sortable wrappers", () => {
    render(
      <SortableVideos ids={["v1", "v2"]} layout="grid" onReorder={() => undefined}>
        <div>
          <SortableVideoItem id="v1">
            <button>打开视频：第一讲</button>
          </SortableVideoItem>
          <SortableVideoItem id="v2">
            <button>打开视频：第二讲</button>
          </SortableVideoItem>
        </div>
      </SortableVideos>,
    );

    expect(screen.getByRole("button", { name: "打开视频：第一讲" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开视频：第二讲" })).toBeInTheDocument();
  });
});

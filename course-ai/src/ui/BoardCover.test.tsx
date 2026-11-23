import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardCover } from "./BoardCover";

describe("BoardCover", () => {
  it("draws AI shapes as elements for a custom subject", () => {
    const { container } = render(
      <BoardCover
        kind="custom"
        number={12}
        art={[
          { t: "path", d: "M160 100 L 200 60" },
          { t: "circle", cx: 200, cy: 80, r: 10 },
          { t: "text", x: 160, y: 140, s: 14, v: "Salmo salar" },
        ]}
      />,
    );
    expect(container.querySelectorAll(".art path.stroke")).toHaveLength(1);
    expect(container.querySelectorAll(".art circle")).toHaveLength(1);
    expect(container.querySelector(".art text")?.textContent).toBe("Salmo salar");
  });

  it("writes the key terms on a plain board", () => {
    const { container } = render(<BoardCover kind="generic" number={3} terms={["虹鳟", "生食标准"]} />);
    const texts = [...container.querySelectorAll(".art text")].map((node) => node.textContent);
    expect(texts).toEqual(["虹鳟", "生食标准"]);
  });

  it("gives an uncoloured course a stable colour from its name", () => {
    const a = render(<BoardCover kind="generic" number={1} caption="新课程 1" />).container;
    const b = render(<BoardCover kind="generic" number={1} caption="新课程 1" />).container;
    const colour = (root: HTMLElement) => (root.querySelector(".no") as HTMLElement).style.color;
    expect(colour(a)).toMatch(/var\(--course-\w+-on-dark\)/);
    expect(colour(a)).toBe(colour(b));
  });
});

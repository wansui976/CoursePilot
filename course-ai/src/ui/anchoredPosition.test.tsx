import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnchoredPosition } from "./anchoredPosition";

const WIDTH = 288;
const HEIGHT = 400;

function Harness({ rect }: { rect: { left: number; top: number; width: number; height: number } }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const style = useAnchoredPosition(true, trigger, panel);
  return (
    <>
      <button
        ref={(node) => {
          trigger.current = node;
          if (node) {
            node.getBoundingClientRect = () =>
              ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top }) as DOMRect;
          }
        }}
      >
        导入
      </button>
      <div ref={panel} data-testid="panel" style={style} />
    </>
  );
}

describe("useAnchoredPosition", () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(rect: { left: number; top: number; width: number; height: number }) {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(650);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(WIDTH);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(HEIGHT);
    render(<Harness rect={rect} />);
    return screen.getByTestId("panel").style;
  }

  it("按钮在右半边：和按钮右缘对齐，往下弹", () => {
    const style = setup({ left: 570, top: 100, width: 90, height: 30 });
    expect(style.left).toBe(`${570 + 90 - WIDTH}px`);
    expect(style.top).toBe("136px");
    expect(style.visibility).toBe("visible");
  });

  it("按钮在左半边（课程页顶部）：和按钮左缘对齐往右展开，不盖到侧栏上", () => {
    const style = setup({ left: 264, top: 110, width: 90, height: 30 });
    expect(style.left).toBe("264px");
    expect(style.top).toBe("146px");
  });

  it("贴着窗口右边：夹回窗口里", () => {
    const style = setup({ left: 960, top: 100, width: 30, height: 30 });
    expect(style.left).toBe(`${990 - WIDTH}px`);
    vi.restoreAllMocks();
  });

  it("按钮靠下（空状态）：下面放不下就往上弹，最多和上面空间一样高", () => {
    const style = setup({ left: 570, top: 420, width: 90, height: 30 });
    expect(style.top).toBe("");
    expect(style.bottom).toBe(`${650 - 420 + 6}px`);
    expect(style.maxHeight).toBe(`${420 - 6 - 8}px`);
  });
});

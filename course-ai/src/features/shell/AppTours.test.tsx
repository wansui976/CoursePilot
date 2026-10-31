import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTours } from "@/stores/tours";
import { AppTours } from "./AppTours";

/** jsdom 里元素没有尺寸：给锚点一个看得见的矩形，引导才会认。 */
function Anchor({ name }: { name: string }) {
  return (
    <button
      type="button"
      data-tour={name}
      ref={(el) => {
        if (el) {
          el.getBoundingClientRect = () =>
            ({ left: 100, top: 100, right: 180, bottom: 130, width: 80, height: 30, x: 100, y: 100 }) as DOMRect;
        }
      }}
    >
      {name}
    </button>
  );
}

function next() {
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
}

const noop = () => {};

describe("AppTours", () => {
  beforeEach(() => {
    localStorage.clear();
    useTours.setState({ seen: new Set(), active: null });
  });

  it("课程页有视频时，依次讲拍题找讲解和知识点", async () => {
    render(
      <>
        <Anchor name="find-explain" />
        <Anchor name="concepts" />
        <AppTours library={false} course={false} courseFeatures workbench={false} navigate={noop} />
      </>,
    );

    expect(
      await screen.findByRole("dialog", { name: "拍一道题，找到课里讲它的地方" }),
    ).toHaveTextContent("1 / 2");
    next();
    expect(
      await screen.findByRole("dialog", { name: "知识点：这门课的概念地图" }),
    ).toHaveTextContent("2 / 2");
  });

  it("工作台引导带上 AI 助手、费曼复述与精华版", async () => {
    render(
      <>
        {[
          "study-tabs",
          "tab-notes",
          "tab-transcript",
          "assistant",
          "chapters",
          "player-stage",
          "reading-focus",
        ].map((name) => (
          <Anchor key={name} name={name} />
        ))}
        <AppTours library={false} course={false} courseFeatures={false} workbench navigate={noop} />
      </>,
    );

    // 第一屏：学习资料。7 步全在（锚点都在）。
    expect(await screen.findByRole("dialog", { name: "学习资料都在这" })).toHaveTextContent("1 / 7");
    next(); // 笔记
    next(); // 文稿
    expect(await screen.findByRole("dialog", { name: "划一句文稿" })).toHaveTextContent("3 / 7");

    next();
    expect(
      await screen.findByRole("dialog", { name: "卡住了，问 AI 助手" }),
    ).toBeInTheDocument();
    next();
    expect(
      await screen.findByRole("dialog", { name: "讲一遍，才知道哪里没懂" }),
    ).toBeInTheDocument();
    next();
    expect(
      await screen.findByRole("dialog", { name: "水分段，快放或跳过" }),
    ).toBeInTheDocument();
    next();
    expect(await screen.findByRole("dialog", { name: "想专心读，就展开" })).toHaveTextContent("7 / 7");
  });

  it("锚点不在的步骤会被跳过：没有章节面板时工作台引导少一步", async () => {
    render(
      <>
        {[
          "study-tabs",
          "tab-notes",
          "tab-transcript",
          "assistant",
          "player-stage",
          "reading-focus",
        ].map((name) => (
          <Anchor key={name} name={name} />
        ))}
        <AppTours library={false} course={false} courseFeatures={false} workbench navigate={noop} />
      </>,
    );

    expect(await screen.findByRole("dialog", { name: "学习资料都在这" })).toHaveTextContent("1 / 6");
  });
});

import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SocraticBlock } from "./socratic";
import { SocraticCard } from "./SocraticCard";

const done = (over: Partial<SocraticBlock> = {}): SocraticBlock => ({
  done: true,
  options: [],
  hints: [],
  summary: [],
  ...over,
});

function renderCard({
  block = done(),
  cardKey,
  onMakeCard = vi.fn().mockResolvedValue(undefined),
  onSeek = vi.fn(),
  canMakeCard = true,
}: {
  block?: SocraticBlock;
  cardKey?: string;
  onMakeCard?: () => Promise<void>;
  onSeek?: (ms: number) => void;
  canMakeCard?: boolean;
} = {}) {
  const rendered = render(
    <SocraticCard
      block={block}
      interactive
      canMakeCard={canMakeCard}
      {...(cardKey ? { cardKey } : {})}
      onPick={() => {}}
      onSeek={onSeek}
      onMakeCard={onMakeCard}
    />,
  );
  return { ...rendered, onMakeCard, onSeek };
}

describe("SocraticCard", () => {
  beforeEach(() => localStorage.clear());

  it("done 但既没要点也没结论：不给「做成复习卡」，免得建出背面空白的卡", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: "做成复习卡" })).toBeNull();
  });

  it("建过卡之后（切走再回来也一样）显示已加入，不再重复建", async () => {
    const onMakeCard = vi.fn().mockResolvedValue(undefined);
    const first = renderCard({ block: done({ summary: ["要点一"] }), cardKey: "turn-1", onMakeCard });
    fireEvent.click(screen.getByRole("button", { name: "做成复习卡" }));
    expect(await screen.findByRole("button", { name: "已加入复习" })).toBeDisabled();
    expect(onMakeCard).toHaveBeenCalledTimes(1);
    first.unmount();

    renderCard({ block: done({ summary: ["要点一"] }), cardKey: "turn-1", onMakeCard });
    expect(screen.getByRole("button", { name: "已加入复习" })).toBeDisabled();
    expect(onMakeCard).toHaveBeenCalledTimes(1);
  });

  it("总结与提示里的时间点可以点着跳回去", () => {
    const onSeek = vi.fn();
    renderCard({ block: done({ summary: ["回看 [07:10] 那一步"] }), onSeek });
    fireEvent.click(screen.getByRole("button", { name: /07:10/ }));
    expect(onSeek).toHaveBeenCalledWith(430_000);
  });

  it("引导进行中的提示与选项仍按进度展示", () => {
    renderCard({
      block: {
        done: false,
        step: 1,
        total: 3,
        options: ["选项 A"],
        hints: ["提示一"],
        summary: [],
      },
    });
    expect(screen.getByText("第 1 / 3 步")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选项 A" })).toBeInTheDocument();
  });
});

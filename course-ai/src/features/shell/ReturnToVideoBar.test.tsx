import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ReturnToVideoBar } from "./ReturnToVideoBar";

describe("ReturnToVideoBar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("写明回到哪门课的哪个视频，点了就回去", () => {
    const onReturn = vi.fn();
    render(<ReturnToVideoBar title="03 梯度下降的直觉.mp4" courseName="机器学习导论" onReturn={onReturn} />);
    const button = screen.getByRole("button", { name: /^回到视频/ });
    expect(button).toHaveTextContent("机器学习导论 · 03 梯度下降的直觉");
    fireEvent.click(button);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { CardBox } from "./CardBox";
import { cardBoxSlot, packWidth } from "@/lib/cardBox";

const DAY = 86_400_000;

describe("卡片盒", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("按评分推到多久之后落进对应的格子", () => {
    expect(cardBoxSlot(60_000)).toBe(0);
    expect(cardBoxSlot(2 * DAY)).toBe(1);
    expect(cardBoxSlot(5 * DAY)).toBe(2);
    expect(cardBoxSlot(20 * DAY)).toBe(3);
    expect(cardBoxSlot(90 * DAY)).toBe(4);
  });

  it("一摞卡的厚度按最满的那格比，空格不画", () => {
    expect(packWidth(0, 10)).toBe(0);
    expect(packWidth(10, 10)).toBe(100);
    expect(packWidth(1, 10)).toBeLessThan(packWidth(5, 10));
  });

  it("五格各写名字和张数，落下的那格做标记", () => {
    render(<CardBox counts={[12, 5, 23, 41, 9]} landed={2} />);
    const slots = screen.getAllByRole("listitem");
    expect(slots).toHaveLength(5);
    expect(slots[3]).toHaveAccessibleName("一个月内：41 张");
    expect(slots[2]).toHaveAttribute("data-landed");
    expect(slots[0]).not.toHaveAttribute("data-landed");
  });
});

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MoreHorizontal, Play } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Badge } from "./badge";
import { EmptyState } from "./empty-state";
import { IconButton } from "./icon-button";
import { Menu, MenuItem } from "./menu";

describe("shared UI primitives", () => {
  it("renders a status badge with dot and stable semantic class", () => {
    render(<Badge tone="success">已处理</Badge>);

    const badge = screen.getByText("已处理");
    expect(badge).toHaveClass("ca-badge", "success");
    expect(badge.querySelector(".dot")).toBeInTheDocument();
  });

  it("renders icon-only actions with accessible names", () => {
    const onClick = vi.fn();

    render(
      <IconButton aria-label="视频操作" onClick={onClick}>
        <MoreHorizontal aria-hidden="true" />
      </IconButton>,
    );

    const button = screen.getByRole("button", { name: "视频操作" });
    expect(button).toHaveClass("ca-icon-btn");
  });

  it("renders menus with consistent item and danger styling", () => {
    render(
      <Menu aria-label="视频操作菜单">
        <MenuItem>修改标题</MenuItem>
        <MenuItem tone="danger">删除</MenuItem>
      </Menu>,
    );

    expect(screen.getByRole("menu", { name: "视频操作菜单" })).toHaveClass(
      "ca-menu",
    );
    expect(screen.getByRole("menuitem", { name: "修改标题" })).toHaveClass(
      "ca-menu-item",
    );
    expect(screen.getByRole("menuitem", { name: "删除" })).toHaveClass(
      "danger",
    );
  });

  it("renders empty states with icon, copy, and optional action", () => {
    render(
      <EmptyState
        icon={<Play aria-hidden="true" />}
        title="还没有视频"
        description="导入本地视频或粘贴视频链接后，会在这里形成课程视频列表。"
        action={<button type="button">导入</button>}
      />,
    );

    expect(screen.getByRole("status")).toHaveClass("ca-empty-state");
    expect(screen.getByRole("heading", { name: "还没有视频" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入" })).toBeInTheDocument();
  });
});

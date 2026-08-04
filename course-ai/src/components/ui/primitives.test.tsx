import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MoreHorizontal, Play } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import * as Dialog from "@radix-ui/react-dialog";
import { Badge } from "./badge";
import { Button } from "./button";
import { EmptyState, PanelEmptyState } from "./empty-state";
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

  it("实色强调按钮的字走 --on-accent，且与其他变体盒模型一致", () => {
    render(
      <Button variant="primary">
        保存
      </Button>,
    );

    const button = screen.getByRole("button", { name: "保存" });
    // 前景必须是 on-accent 令牌：写死 text-white 的话，暗色主题下的按下态就跟不上了。
    expect(button).toHaveClass("bg-[var(--accent)]", "text-[var(--on-accent)]");
    expect(button).not.toHaveClass("text-white");
    // 同色描边：与 default/outline 并排时内容盒等宽等高，不会差出一圈边框。
    expect(button).toHaveClass("border", "border-[var(--accent)]");
    // 悬停换成设计好的按下色，而不是把整颗按钮连字一起调淡——后者会让标签更难读，
    // 而各页面手搓的强调按钮当初正是一半用 opacity-90、一半用别的。
    expect(button).toHaveClass(
      "hover:bg-[var(--accent-press)]",
      "hover:text-[var(--on-accent-press)]",
    );
    expect(button.className).not.toMatch(/hover:opacity-/);
  });

  it("对话框进出有动画可挂：Radix 打的 data-state 落在遮罩和面板上", () => {
    render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Overlay className="ca-dialog-overlay" data-testid="ov" />
          <Dialog.Content aria-describedby={undefined}>
            <Dialog.Title>标题</Dialog.Title>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );

    // 动画挂在 [data-state] 上，Radix 会在关闭时保持挂载直到动画跑完；
    // 少了这两个钩子，对话框就退回硬切。
    expect(screen.getByTestId("ov")).toHaveAttribute("data-state", "open");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "open");
  });

  it("面板空态在剩余空间里居中，且与首页空态是同一套外观", () => {
    render(
      <PanelEmptyState
        icon={<Play aria-hidden="true" />}
        title="还没有章节"
        description="字幕就绪后会自动生成。"
      />,
    );

    const state = screen.getByRole("status");
    expect(state).toHaveClass("ca-empty-state");
    expect(screen.getByRole("heading", { name: "还没有章节" })).toBeInTheDocument();
    // 居中容器包在外面：面板里的空态不该像段落一样贴在左上角。
    expect(state.parentElement).toHaveClass("items-center", "justify-center");
  });
});

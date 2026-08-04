import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)]",
        // 实色强调按钮。此前没有这一档，于是每个页面各自手搓一个：圆角 lg 和 md 都有，
        // hover 有的 opacity-90（把文字一起变淡）、有的 bg-primary/90、有的干脆没有，
        // 前景一律写死 text-white 再靠一层属性选择器 CSS 把它改回 --on-accent。
        // 归到这里之后，「主操作」在全应用只有一种长相和一种按下去的反应。
        // 带一圈同色描边，好让它与 default/outline 的盒模型一模一样——并排放时
        // 内容盒等宽等高，不会因为少了 1px 边框而与旁边的按钮错开。
        primary:
          "border border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] hover:border-[var(--accent-press)] hover:bg-[var(--accent-press)] hover:text-[var(--on-accent-press)]",
        destructive: "bg-red-600 text-white hover:bg-red-500",
        outline:
          "border border-[var(--border-subtle)] bg-transparent text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)]",
        secondary:
          "bg-[var(--surface-card-active)] text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)]",
        ghost:
          "text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

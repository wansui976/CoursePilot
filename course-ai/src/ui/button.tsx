import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "ca-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none [&_svg]:h-4 [&_svg]:w-4 [&_svg]:flex-none",
  {
    variants: {
      variant: {
        default:
          "border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-strong)] shadow-[var(--shadow-raise)] hover:bg-[var(--surface-card-hover)] disabled:opacity-50",
        // 实色强调按钮。此前没有这一档，于是每个页面各自手搓一个：圆角 lg 和 md 都有，
        // hover 有的 opacity-90（把文字一起变淡）、有的 bg-primary/90、有的干脆没有，
        // 前景一律写死 text-white 再靠一层属性选择器 CSS 把它改回 --on-accent。
        // 归到这里之后，「主操作」在全应用只有一种长相和一种按下去的反应。
        // 带一圈同色描边，好让它与 default/outline 的盒模型一模一样——并排放时
        // 内容盒等宽等高，不会因为少了 1px 边框而与旁边的按钮错开。
        // 禁用的主操作退成中性的实色面：半透明强调蓝在浅色下文字发灰、在深色下几乎看不见，
        // 既不像「不可点」也不像一个按钮。灰底 + 提示色文字是系统设置里禁用的标准长相。
        primary:
          "ca-sheen ca-btn-primary border border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] hover:border-[var(--accent-press)] hover:bg-[var(--accent-press)] hover:text-[var(--on-accent-press)] disabled:border-transparent disabled:bg-[var(--surface-card-hover)] disabled:text-[var(--text-faint)] disabled:shadow-none",
        destructive:
          "border border-transparent bg-[var(--status-err)] text-[var(--on-status-err)] hover:brightness-95 disabled:opacity-50",
        outline:
          "border border-[var(--border-subtle)] bg-transparent text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)] disabled:opacity-50",
        secondary:
          "border border-transparent bg-[var(--surface-card-hover)] text-[var(--text-strong)] hover:bg-[var(--border-subtle)] disabled:opacity-50",
        ghost:
          "border border-transparent text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] disabled:opacity-50",
        // 文字链接：查看出处这类行内动作。
        link: "h-auto border-0 !px-0 !py-0 text-[var(--accent-text)] underline decoration-[color-mix(in_srgb,var(--accent-text)_35%,transparent)] underline-offset-[3px] hover:decoration-current",
      },
      size: {
        default: "h-8 px-3",
        // 小号按钮跟字阶的 sm 档（13px）：12px 与旁边 15px 的输入框并排时显得发虚。
        sm: "h-7 rounded-md px-2.5 text-[13px]",
        lg: "h-10 rounded-md px-[18px] text-[15px]",
        icon: "h-8 w-8",
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

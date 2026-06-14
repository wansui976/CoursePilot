import * as React from "react";
import { cn } from "@/lib/utils";

export function Menu({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="menu" className={cn("ca-menu", className)} {...props}>
      {children}
    </div>
  );
}

export function MenuItem({
  className,
  tone = "default",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "default" | "danger";
}) {
  return (
    <button
      type={type}
      role="menuitem"
      className={cn("ca-menu-item", tone === "danger" && "danger", className)}
      {...props}
    />
  );
}

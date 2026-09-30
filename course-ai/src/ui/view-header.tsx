import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 次级视图统一头部：返回键 + 大标题(可选描述) + 右侧操作区。
 *
 * 此前 Dashboard/回收站/处理队列/开发者台各写一套头部：字号 text-lg 与 text-2xl
 * 混杂、标题带不带图标不统一、内边距三种写法。收敛到这里之后，「一个视图的头」
 * 全应用只有一种长相。标题纯字无图标锁扣——靠字阶层级而不是装饰图标。
 */
export function ViewHeader({
  title,
  description,
  onBack,
  backLabel,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <header className={cn("ca-view-header", className)}>
      {onBack ? (
        <button
          type="button"
          className="ca-icon-btn ca-touch-44 -ml-2"
          aria-label={backLabel ?? t("common.back")}
          onClick={onBack}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      ) : null}
      <div className="ca-view-header-text">
        <h1 className="ca-view-title">{title}</h1>
        {description ? <p className="ca-view-desc">{description}</p> : null}
      </div>
      {actions ? <div className="ca-view-header-actions">{actions}</div> : null}
    </header>
  );
}

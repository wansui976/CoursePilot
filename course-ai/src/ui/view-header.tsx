import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { displayTitle } from "@/lib/videoTitle";
import { useOptionalShell } from "@/app/shell";

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
  level = "secondary",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  /** root：侧栏一级入口（学习面板、处理队列、设置），与课程库同款的大标题、坐在页面底色上。 */
  level?: "root" | "secondary";
  className?: string;
}) {
  const { t } = useTranslation();
  const videoReturn = useOptionalShell()?.videoReturn ?? null;
  return (
    <header className={cn("ca-view-header", className)} data-level={level}>
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
        {videoReturn ? (
          // 设计系统里根级页头标题上方的那行面包屑：13px 无衬线、淡色，链接用 text-muted。
          // 叠在视频会话上的整页都有一条回去的路，写明回哪门课的哪个视频。
          <button
            type="button"
            className="ca-view-crumb"
            onClick={videoReturn.onReturn}
            aria-label={t("nav.returnToVideoLabel", { title: displayTitle(videoReturn.title) })}
            title={t("nav.returnToVideo")}
          >
            <ChevronLeft className="ca-view-crumb-icon" aria-hidden="true" />
            {videoReturn.courseName ? (
              <>
                <span className="ca-view-crumb-course">{videoReturn.courseName}</span>
                <span className="ca-view-crumb-sep" aria-hidden="true">/</span>
              </>
            ) : null}
            <span className="ca-view-crumb-video">{displayTitle(videoReturn.title)}</span>
          </button>
        ) : null}
        <h1 className="ca-view-title">{title}</h1>
        {description ? <p className="ca-view-desc">{description}</p> : null}
      </div>
      {actions ? <div className="ca-view-header-actions">{actions}</div> : null}
    </header>
  );
}

import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { displayTitle } from "@/lib/videoTitle";

/**
 * 设置、回收站、学习、控制台、处理队列这些整页叠在视频会话上时，顶上的一条「回到视频」。
 *
 * 这些整页本来就保留着当前视频（路由里还带着 video），按 Esc / 系统返回也能回去，
 * 但界面上没有任何入口：桌面左侧工具栏只有「回到课程库首页」，点了反而把视频关掉；
 * 手机上要猜到点底栏「课程」才行。所以把回去的路直接摆在页顶，写明回到哪个视频。
 */
export function ReturnToVideoBar({
  title,
  courseName,
  onReturn,
}: {
  title: string;
  courseName?: string | null;
  onReturn: () => void;
}) {
  const { t } = useTranslation();
  const shown = displayTitle(title);
  return (
    <div className="ca-return-video">
      <button
        type="button"
        onClick={onReturn}
        aria-label={t("nav.returnToVideoLabel", { title: shown })}
        className="ca-return-video-btn"
      >
        <ArrowLeft className="h-4 w-4 flex-none" aria-hidden="true" />
        <span className="flex-none font-medium">{t("nav.returnToVideo")}</span>
        <span className="min-w-0 truncate text-[var(--text-muted)]">
          {courseName ? `${courseName} · ${shown}` : shown}
        </span>
      </button>
    </div>
  );
}

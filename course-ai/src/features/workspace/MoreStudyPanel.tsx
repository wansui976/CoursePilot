import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Brain,
  FileText,
  GitBranch,
  MessagesSquare,
  Scissors,
  Search,
} from "lucide-react";
import { TextSkeleton } from "@/ui/skeleton";

const QuizPanel = lazy(() =>
  import("./QuizPanel").then((module) => ({ default: module.QuizPanel })),
);
const SlidesPanel = lazy(() =>
  import("./SlidesPanel").then((module) => ({ default: module.SlidesPanel })),
);
const MindmapPanel = lazy(() =>
  import("./MindmapPanel").then((module) => ({ default: module.MindmapPanel })),
);
const ClipsPanel = lazy(() =>
  import("./ClipsPanel").then((module) => ({ default: module.ClipsPanel })),
);
const RagSearchPanel = lazy(() =>
  import("./RagSearchPanel").then((module) => ({
    default: module.RagSearchPanel,
  })),
);
const CommentsPanel = lazy(() =>
  import("./CommentsPanel").then((module) => ({ default: module.CommentsPanel })),
);

type MoreView = "quiz" | "slides" | "mindmap" | "clips" | "search" | "comments";

const MORE_VIEW_KEYS: MoreView[] = [
  "quiz",
  "slides",
  "mindmap",
  "clips",
  "search",
  "comments",
];
// 与一级 tab 同款图标语言（下划线式 + 图标），二级导航不再用另一套药丸样式。
const MORE_ICONS: Record<MoreView, typeof FileText> = {
  quiz: Brain,
  slides: FileText,
  mindmap: GitBranch,
  clips: Scissors,
  search: Search,
  comments: MessagesSquare,
};

/** initialView：上层把存量「练习」一级标签迁进来时，落点直接定位到练习视图。 */
export function MoreStudyPanel({
  videoId,
  initialView,
}: {
  videoId: string;
  initialView?: MoreView;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<MoreView>(initialView ?? "quiz");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 二级切换用轻量胶囊，与上方一级的分段控件拉开层级（原先的下划线页签和分段控件
          叠在一起，两层导航长得像两套设计）。 */}
      <div className="flex-none border-b border-[var(--border-faint)] px-3 py-2">
        <div
          role="group"
          aria-label={t("morePanel.label")}
          className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {MORE_VIEW_KEYS.map((key) => {
            const Icon = MORE_ICONS[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={`ca-touch-44 flex h-8 min-w-max items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${
                  view === key
                    ? "bg-[var(--accent-weak)] text-[var(--accent-text)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-normal)]"
                }`}
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
                {t(`morePanel.${key}`)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="p-4">
              <TextSkeleton lines={6} />
            </div>
          }
        >
          {view === "quiz" && <QuizPanel videoId={videoId} />}
          {view === "slides" && <SlidesPanel videoId={videoId} />}
          {view === "mindmap" && <MindmapPanel videoId={videoId} />}
          {view === "clips" && <ClipsPanel videoId={videoId} />}
          {view === "search" && (
            <RagSearchPanel videoId={videoId} mode="search" />
          )}
          {view === "comments" && <CommentsPanel videoId={videoId} />}
        </Suspense>
      </div>
    </div>
  );
}

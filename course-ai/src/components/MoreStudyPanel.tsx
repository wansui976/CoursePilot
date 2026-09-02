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
import { TextSkeleton } from "@/components/ui/skeleton";

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
      <div className="flex-none border-b border-[var(--border-subtle)] px-2.5">
        <div
          role="group"
          aria-label={t("morePanel.label")}
          className="flex h-10 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {MORE_VIEW_KEYS.map((key) => {
            const Icon = MORE_ICONS[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={`ca-touch-44 flex min-h-10 min-w-max flex-1 items-center justify-center gap-1 border-b-[3px] px-2 py-2 text-xs font-semibold transition-colors ${
                  view === key
                    ? "border-primary text-[var(--text-strong)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-normal)]"
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

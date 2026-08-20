import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, GitBranch, Scissors, Search } from "lucide-react";
import { TextSkeleton } from "@/components/ui/skeleton";

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

type MoreView = "slides" | "mindmap" | "clips" | "search";

const MORE_VIEW_KEYS: MoreView[] = ["slides", "mindmap", "clips", "search"];
// 与一级 tab 同款图标语言（下划线式 + 图标），二级导航不再用另一套药丸样式。
const MORE_ICONS: Record<MoreView, typeof FileText> = {
  slides: FileText,
  mindmap: GitBranch,
  clips: Scissors,
  search: Search,
};

export function MoreStudyPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<MoreView>("slides");

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
                className={`ca-touch-44 flex min-h-10 min-w-max flex-1 items-center justify-center gap-1.5 border-b-[3px] px-3 py-2 text-xs font-semibold transition-colors ${
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
          {view === "slides" && <SlidesPanel videoId={videoId} />}
          {view === "mindmap" && <MindmapPanel videoId={videoId} />}
          {view === "clips" && <ClipsPanel videoId={videoId} />}
          {view === "search" && (
            <RagSearchPanel videoId={videoId} mode="search" />
          )}
        </Suspense>
      </div>
    </div>
  );
}

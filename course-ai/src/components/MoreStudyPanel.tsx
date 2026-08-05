import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
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

export function MoreStudyPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<MoreView>("slides");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none border-b border-[var(--border-subtle)] px-3 py-2">
        <div
          role="group"
          aria-label={t("morePanel.label")}
          className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md bg-[var(--surface-card)] p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {MORE_VIEW_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={`ca-touch-44 min-w-max rounded px-3 py-1 text-xs font-medium transition-colors ${
                view === key
                  ? "bg-[var(--surface-panel)] text-[var(--text-strong)] shadow-[var(--shadow-raise)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-normal)]"
              }`}
            >
              {t(`morePanel.${key}`)}
            </button>
          ))}
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

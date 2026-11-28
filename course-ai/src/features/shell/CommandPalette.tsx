import * as Dialog from "@radix-ui/react-dialog";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Clock,
  Keyboard,
  ClipboardList,
  CornerDownLeft,
  LayoutDashboard,
  Library,
  MessageSquareText,
  Moon,
  PlayCircle,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Timer,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOptionalShell } from "@/app/shell";
import { CATEGORY_META, SETTINGS_CATEGORIES } from "@/features/settings/categories";
import { isPaletteShortcut, parseTimeQuery, rankEntries, type PaletteEntry, type PaletteGroup } from "@/lib/commandPalette";
import { queries } from "@/lib/queries";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import type { Video } from "@/lib/types";
import { useFocusTimer } from "@/stores/focusTimer";
import { useStudyNav } from "@/stores/studyNav";
import type { StudyTarget } from "@/lib/backgroundTasks";
import type { ShellNav } from "./shellNav";
import { SHORTCUT_HELP_EVENT } from "./ShortcutHelp";

type Entry = PaletteEntry & { icon: LucideIcon; run: () => void };

const STUDY_TABS: { id: string; target: StudyTarget; i18nKey: string }[] = [
  { id: "overview", target: { tab: "overview" }, i18nKey: "palette.tab.overview" },
  { id: "transcript", target: { tab: "transcript" }, i18nKey: "palette.tab.transcript" },
  { id: "notes", target: { tab: "notes" }, i18nKey: "palette.tab.notes" },
  { id: "quiz", target: { tab: "more", moreView: "quiz" }, i18nKey: "palette.tab.quiz" },
  { id: "slides", target: { tab: "more", moreView: "slides" }, i18nKey: "palette.tab.slides" },
  { id: "mindmap", target: { tab: "more", moreView: "mindmap" }, i18nKey: "palette.tab.mindmap" },
];

/**
 * 命令面板：一个输入框找课程、视频、页面和设置分类；当前开着视频时，输入「12:30」直接跳过去。
 * 只在桌面上用快捷键叫出来（手机没有键盘，入口已经在底栏和课程列表里）。
 */
export function CommandPalette({ nav }: { nav: ShellNav }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!open) return null;
  return <PaletteDialog nav={nav} onClose={() => setOpen(false)} />;
}

function PaletteDialog({ nav, onClose }: { nav: ShellNav; onClose: () => void }) {
  const { t } = useTranslation();
  const shell = useOptionalShell();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const { data: courses = [] } = useQuery(queries.courses());
  const videoLists = useQueries({
    queries: courses.map((course) => queries.videos(course.id)),
  });
  const focusRunning = useFocusTimer((s) => s.phase !== "idle");

  const run = useCallback(
    (action: () => void) => {
      onClose();
      // 先让对话框收起、焦点还回去，再导航：否则 Radix 还焦点会把刚打开的页面的焦点抢走。
      window.setTimeout(action, 0);
    },
    [onClose],
  );

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const video = shell?.selectedVideo;
    const timeMs = parseTimeQuery(query);
    if (video && timeMs != null) {
      out.push({
        id: "time",
        group: "time",
        icon: Clock,
        label: t("palette.jumpTo", { time: formatMs(timeMs) }),
        detail: displayTitle(video.title),
        keywords: [query],
        run: () => shell.openVideoAt(video.id, timeMs),
      });
    }
    const page = (id: string, icon: LucideIcon, label: string, action: () => void, keywords: string[] = []) =>
      out.push({ id: `page:${id}`, group: "page", icon, label, keywords, run: action });
    if (video) {
      for (const tab of STUDY_TABS) {
        page(`tab-${tab.id}`, BookOpen, t(tab.i18nKey), () => {
          useStudyNav.getState().open(video.id, tab.target);
          shell?.videoReturn?.onReturn();
        }, [t("palette.tab.prefix")]);
      }
    }
    page("library", Library, t("palette.page.library"), nav.onGoLibraryHome, ["home", "library"]);
    page("dashboard", LayoutDashboard, t("palette.page.dashboard"), nav.onOpenDashboard, ["dashboard", "study", "review"]);
    page("queue", ClipboardList, t("palette.page.queue"), () => {
      if (!nav.queueOpen) nav.onToggleQueue();
    }, ["queue"]);
    page("assistant", MessageSquareText, t("palette.page.assistant"), nav.onToggleAssistant, ["assistant", "ai", "chat"]);
    page(
      "theme",
      nav.theme === "dark" ? Sun : Moon,
      nav.theme === "dark" ? t("palette.page.themeLight") : t("palette.page.themeDark"),
      nav.onToggleTheme,
      ["theme", "dark", "light"],
    );
    page(
      "focus",
      Timer,
      focusRunning ? t("palette.page.focusStop") : t("palette.page.focusStart"),
      () => {
        const timer = useFocusTimer.getState();
        if (focusRunning) timer.stop();
        else timer.start();
      },
      ["pomodoro", "focus", "番茄"],
    );
    page("shortcuts", Keyboard, t("palette.page.shortcuts"), () => {
      window.dispatchEvent(new Event(SHORTCUT_HELP_EVENT));
    }, ["keyboard", "shortcuts", "hotkeys", "?"]);
    page("recycle", Trash2, t("palette.page.recycle"), nav.onOpenRecycleBin, ["trash"]);
    page("settings", Settings, t("palette.page.settings"), nav.onOpenSettings, ["settings", "preferences"]);

    courses.forEach((course) => {
      out.push({
        id: `course:${course.id}`,
        group: "course",
        icon: Library,
        label: course.name,
        detail: t("palette.videoCount", { count: course.video_count }),
        run: () => shell?.selectCourse(course.id),
      });
    });

    // 当前课程的视频排在前面：空查询时看到的就是手边这门课。
    const currentCourseId = shell?.selectedCourse?.id ?? video?.course_id ?? null;
    const lists = courses.map((course, index) => ({ course, videos: videoLists[index]?.data ?? [] }));
    lists.sort((a, b) => Number(b.course.id === currentCourseId) - Number(a.course.id === currentCourseId));
    for (const { course, videos } of lists) {
      for (const item of videos as Video[]) {
        out.push({
          id: `video:${item.id}`,
          group: "video",
          icon: PlayCircle,
          label: displayTitle(item.title),
          detail: course.name,
          run: () => shell?.openQueuedVideo(item),
        });
      }
    }

    for (const category of SETTINGS_CATEGORIES) {
      out.push({
        id: `setting:${category}`,
        group: "setting",
        icon: SlidersHorizontal,
        label: t(CATEGORY_META[category].i18nKey),
        detail: t("palette.page.settings"),
        keywords: [category],
        run: () => shell?.openSettingsCategory(category),
      });
    }
    return out;
  }, [courses, videoLists, nav, query, shell, t, focusRunning]);

  const results = useMemo(() => rankEntries(entries, query, query ? 8 : 5), [entries, query]);
  useEffect(() => setActive(0), [query]);
  const safeActive = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${safeActive}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [safeActive]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((safeActive + 1) % Math.max(1, results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((safeActive - 1 + results.length) % Math.max(1, results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = results[safeActive];
      if (entry) run(entry.run);
    }
  };

  let lastGroup: PaletteGroup | null = null;
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="ca-dialog-overlay fixed inset-0 z-[60] flex items-start justify-center bg-[rgb(13_16_15/0.32)] px-4 pt-[12vh]">
          <Dialog.Content
            aria-modal="true"
            aria-describedby={undefined}
            data-testid="command-palette"
            className="ca-palette flex max-h-[min(560px,76vh)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl bg-[var(--surface-panel)] text-[var(--text-normal)] shadow-[var(--shadow-pop)]"
          >
            <Dialog.Title className="sr-only">{t("palette.title")}</Dialog.Title>
            <div className="flex items-center gap-2 border-b border-[var(--border-faint)] px-4">
              <Search className="h-4 w-4 flex-none text-[var(--text-muted)]" aria-hidden="true" />
              <input
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={results[safeActive] ? `${listId}-${safeActive}` : undefined}
                aria-label={t("palette.title")}
                placeholder={
                  shell?.selectedVideo ? t("palette.placeholderVideo") : t("palette.placeholder")
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
                className="h-12 min-w-0 flex-1 bg-transparent font-[var(--font-app)] text-[15px] text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)]"
              />
              <kbd className="ca-kbd">Esc</kbd>
            </div>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={t("palette.results")}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
            >
              {results.length === 0 && (
                <p className="px-3 py-6 text-center text-[13px] text-[var(--text-muted)]">
                  {t("palette.empty")}
                </p>
              )}
              {results.map((entry, index) => {
                const header = entry.group !== lastGroup;
                lastGroup = entry.group;
                const Icon = entry.icon;
                const selected = index === safeActive;
                return (
                  <div key={entry.id}>
                    {header && (
                      <div
                        role="presentation"
                        className="px-2.5 pb-1 pt-2.5 font-[var(--font-display)] text-[12px] font-medium text-[var(--text-muted)]"
                      >
                        {t(`palette.group.${entry.group}`)}
                      </div>
                    )}
                    <div
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={selected}
                      data-index={index}
                      onPointerMove={() => setActive(index)}
                      onClick={() => run(entry.run)}
                      className={`flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[var(--r-xs)] px-2.5 py-1.5 text-[13px] ${
                        selected
                          ? "bg-[var(--surface-card-active)] text-[var(--text-strong)]"
                          : "text-[var(--text-normal)]"
                      }`}
                    >
                      <Icon
                        aria-hidden="true"
                        className={`h-4 w-4 flex-none ${entry.group === "time" ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]"}`}
                      />
                      <span className="min-w-0 truncate">{entry.label}</span>
                      {entry.detail && (
                        <span className="ml-auto min-w-0 flex-none truncate pl-3 text-[12px] text-[var(--text-faint)] max-w-[40%]">
                          {entry.detail}
                        </span>
                      )}
                      {selected && (
                        <CornerDownLeft
                          aria-hidden="true"
                          className={`h-3.5 w-3.5 flex-none text-[var(--text-faint)] ${entry.detail ? "" : "ml-auto"}`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-3 border-t border-[var(--border-faint)] px-4 py-2 text-[12px] text-[var(--text-faint)]">
              <span className="flex items-center gap-1">
                <kbd className="ca-kbd">↑</kbd>
                <kbd className="ca-kbd">↓</kbd>
                {t("palette.hintMove")}
              </span>
              <span className="flex items-center gap-1">
                <kbd className="ca-kbd">↵</kbd>
                {t("palette.hintOpen")}
              </span>
              {shell?.selectedVideo && <span className="ml-auto">{t("palette.hintTime")}</span>}
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

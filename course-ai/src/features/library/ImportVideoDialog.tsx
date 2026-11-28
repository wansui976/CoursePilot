import {
  AlertCircle,
  Cable,
  ChevronDown,
  Download,
  FileVideo,
  FolderInput,
  FolderPlus,
  HardDriveDownload,
  GraduationCap,
  ListVideo,
  Plus,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAnchoredPosition } from "@/ui/anchoredPosition";
import { qk } from "@/lib/queryKeys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc, type FolderVideo } from "@/lib/ipc";
import { cableImportAvailable, pickDirectoryPath, pickPersistedFile } from "@/lib/mobileFiles";
import { isMobile } from "@/lib/platform";

// 按需懒加载：下载向导只在用户点击时才需要，避免把它（及 plugin-dialog 等）压进首屏 eager 包。
const CableImportDialog = lazy(() =>
  import("./CableImportDialog").then((m) => ({ default: m.CableImportDialog })),
);
const BilibiliImportDialog = lazy(() =>
  import("./BilibiliImportDialog").then((m) => ({ default: m.BilibiliImportDialog })),
);
const FolderImportDialog = lazy(() =>
  import("./FolderImportDialog").then((m) => ({ default: m.FolderImportDialog })),
);
const WebDavImportDialog = lazy(() =>
  import("./WebDavImportDialog").then((m) => ({ default: m.WebDavImportDialog })),
);
const ChaoxingImportDialog = lazy(() =>
  import("./ChaoxingImportDialog").then((m) => ({ default: m.ChaoxingImportDialog })),
);
const PlaylistImportDialog = lazy(() =>
  import("./PlaylistImportDialog").then((m) => ({ default: m.PlaylistImportDialog })),
);

/** 单一「导入」入口：点开后可选「上传本地视频」或「下载网络视频（B 站 / 链接）」。 */
export function ImportVideoButton({
  courseId,
  onCreateFolder,
}: {
  courseId: string;
  /** 给了就在菜单最后加一项「新建文件夹」：往课程里「添加」的入口都收在这一个按钮里。 */
  onCreateFolder?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // 菜单挂到 body 上、按窗口里剩下的空间选方向：课程页顶部的按钮靠左、空状态里的按钮靠下，
  // 原来固定「右对齐、往下弹」，一个被内容区左缘裁掉，一个伸出窗口底部。
  const menuStyle = useAnchoredPosition(menuOpen, triggerRef, menuRef);
  // 导入失败的提示和菜单同一侧展开：按钮靠左时往右伸。
  const [alignLeft, setAlignLeft] = useState(false);
  const [showBili, setShowBili] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showChaoxing, setShowChaoxing] = useState(false);
  const [showDrive, setShowDrive] = useState(false);
  const [showCable, setShowCable] = useState(false);
  const [folderVideos, setFolderVideos] = useState<FolderVideo[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // 移动端无 yt-dlp sidecar / 无法扫描任意文件夹，隐藏「下载网络视频」「导入整个文件夹」入口。
  const mobile = isMobile();
  // 数据线导入只在手机 / 平板上有：iOS 用 Finder / Apple 设备往 App「文稿」里拖，
  // Android 用 USB「文件传输」往 App 媒体目录的「导入」文件夹里拖。
  const cable = cableImportAvailable();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: qk.videos.list(courseId) });

  const menuItems = useCallback(
    () =>
      Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []),
    [],
  );

  const closeMenuAndRestoreFocus = useCallback(() => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    menuItems()[0]?.focus();

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeMenuAndRestoreFocus();
    };

    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, [closeMenuAndRestoreFocus, menuItems, menuOpen]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenuAndRestoreFocus();
      return;
    }
    if (event.key === "Tab") {
      setMenuOpen(false);
      return;
    }
    if (!items.length) return;

    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (activeIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (activeIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex == null) return;

    event.preventDefault();
    items[nextIndex]?.focus();
  };

  // 选一个文件夹 → 扫描其中的视频 → 打开勾选清单批量导入。
  const folder = useMutation({
    mutationFn: async () => {
      setImportError(null);
      const dir = await pickDirectoryPath();
      if (!dir) return null;
      return ipc.videos.scanFolder(dir);
    },
    onSuccess: (videos) => {
      if (videos == null) return; // 用户取消了选目录
      if (videos.length === 0) {
        setImportError(t("import.noVideosInFolder"));
        return;
      }
      setFolderVideos(videos);
    },
    onError: (error) => setImportError(humanizeError(error)),
  });

  const local = useMutation({
    mutationFn: async () => {
      setImportError(null);
      const persisted = await pickPersistedFile({
        category: "videos",
        fallbackName: "video.mp4",
        filters: [
          {
            name: "Video / Audio",
            extensions: ["mp4", "mkv", "mov", "webm", "m4v", "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"],
          },
        ],
        prompt: t("import.selectLocalVideo"),
      });
      if (!persisted) return null;
      return ipc.videos.addLocal(courseId, persisted.path, persisted.durationMs);
    },
    onSuccess: () => {
      setImportError(null);
      invalidate();
    },
    onError: (error) => {
      setImportError(humanizeError(error));
    },
  });

  return (
    <div className="relative flex-none">
      <Button
        ref={triggerRef}
        size="sm"
        data-tour="import"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        onClick={() => {
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) setAlignLeft(rect.left + rect.width / 2 < window.innerWidth / 2);
          setMenuOpen((o) => !o);
        }}
      >
        <Plus className="h-4 w-4" />
        {t("import.title")}
        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
      </Button>
      {menuOpen && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-40" aria-hidden="true" />
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={t("import.title")}
            onKeyDown={handleMenuKeyDown}
            style={menuStyle}
            className="z-50 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1.5 shadow-[var(--shadow-pop)]"
          >
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false);
                local.mutate();
              }}
              className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
            >
              <FileVideo className="mt-0.5 h-4 w-4 flex-none text-primary" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-strong)]">
                  {t("import.uploadLocal")}
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  {t(mobile ? "import.uploadHintMobile" : "import.uploadHint")}
                </span>
              </span>
            </button>

            {cable && (
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setMenuOpen(false);
                  setShowCable(true);
                }}
                className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
              >
                <Cable className="mt-0.5 h-4 w-4 flex-none text-primary" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--text-strong)]">
                    {t("import.fromComputer")}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {t("import.fromComputerHint")}
                  </span>
                </span>
              </button>
            )}

            {!mobile && (
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setMenuOpen(false);
                  folder.mutate();
                }}
                className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
              >
                <FolderInput className="mt-0.5 h-4 w-4 flex-none text-primary" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--text-strong)]">
                    {t("import.importFolder")}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {t("import.importFolderHint")}
                  </span>
                </span>
              </button>
            )}

            {/* 网盘导入：纯 HTTP，手机上也能用（在线看不占手机空间）。 */}
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false);
                setShowDrive(true);
              }}
              className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
            >
              <HardDriveDownload className="mt-0.5 h-4 w-4 flex-none text-primary" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-strong)]">{t("import.fromDrive")}</span>
                <span className="block text-xs text-[var(--text-muted)]">{t("import.fromDriveHint")}</span>
              </span>
            </button>

            {!mobile && (
              <>
                <div className="my-1 border-t border-[var(--border-faint)]" />
                <button
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setMenuOpen(false);
                    setShowBili(true);
                  }}
                  className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
                >
                  <Download className="mt-0.5 h-4 w-4 flex-none text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-strong)]">
                      {t("import.downloadOnline")}
                    </span>
                    <span className="block text-xs text-[var(--text-muted)]">
                      {t("import.downloadOnlineHint")}
                    </span>
                  </span>
                </button>
                <button
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setMenuOpen(false);
                    setShowPlaylist(true);
                  }}
                  className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
                >
                  <ListVideo className="mt-0.5 h-4 w-4 flex-none text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-strong)]">
                      {t("import.importPlaylist")}
                    </span>
                    <span className="block text-xs text-[var(--text-muted)]">
                      {t("import.importPlaylistHint")}
                    </span>
                  </span>
                </button>
                <button
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setMenuOpen(false);
                    setShowChaoxing(true);
                  }}
                  className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
                >
                  <GraduationCap className="mt-0.5 h-4 w-4 flex-none text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-strong)]">
                      {t("import.fromChaoxing")}
                    </span>
                    <span className="block text-xs text-[var(--text-muted)]">
                      {t("import.fromChaoxingHint")}
                    </span>
                  </span>
                </button>
              </>
            )}
            {onCreateFolder && (
              <>
                <div className="my-1 border-t border-[var(--border-faint)]" />
                <button
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setMenuOpen(false);
                    onCreateFolder();
                  }}
                  className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
                >
                  <FolderPlus className="mt-0.5 h-4 w-4 flex-none text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-strong)]">
                      {t("folders.newFolder")}
                    </span>
                    <span className="block text-xs text-[var(--text-muted)]">
                      {t("folders.newFolderHint")}
                    </span>
                  </span>
                </button>
              </>
            )}
          </div>
        </>,
        document.body,
      )}
      {showCable && (
        <Suspense fallback={null}>
          <CableImportDialog
            courseId={courseId}
            onClose={() => setShowCable(false)}
            returnFocusRef={triggerRef}
          />
        </Suspense>
      )}
      {showBili && (
        <Suspense fallback={null}>
          <BilibiliImportDialog
            courseId={courseId}
            onClose={() => setShowBili(false)}
            returnFocusRef={triggerRef}
          />
        </Suspense>
      )}
      {folderVideos && (
        <Suspense fallback={null}>
          <FolderImportDialog
            courseId={courseId}
            videos={folderVideos}
            onClose={() => setFolderVideos(null)}
            returnFocusRef={triggerRef}
          />
        </Suspense>
      )}
      {showDrive && (
        <Suspense fallback={null}>
          <WebDavImportDialog
            courseId={courseId}
            onClose={() => setShowDrive(false)}
            returnFocusRef={triggerRef}
          />
        </Suspense>
      )}
      {showChaoxing && (
        <Suspense fallback={null}>
          <ChaoxingImportDialog
            courseId={courseId}
            onClose={() => setShowChaoxing(false)}
            returnFocusRef={triggerRef}
          />
        </Suspense>
      )}
      {showPlaylist && (
        <Suspense fallback={null}>
          <PlaylistImportDialog
            courseId={courseId}
            onClose={() => setShowPlaylist(false)}
            returnFocusRef={triggerRef}
          />
        </Suspense>
      )}
      {importError && (
        // 语义错误色（主题感知），不再用硬编码 tailwind 红。importError 已是人话，
        // 这里直接展示、保留「导入失败：」前缀，不再过一遍 humanizeError（会吞掉前缀）。
        <div
          role="alert"
          className={`absolute ${alignLeft ? "left-0" : "right-0"} top-full z-20 mt-2 flex w-72 max-w-[calc(100vw-2rem)] items-start gap-2 rounded-lg bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)] shadow-[var(--shadow-pop)]`}
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span className="min-w-0 break-words">{t("import.importFailed", { error: importError })}</span>
        </div>
      )}
    </div>
  );
}

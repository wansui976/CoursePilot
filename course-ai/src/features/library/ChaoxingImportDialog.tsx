import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { Modal } from "@/ui/dialog";
import { ipc, type ChaoxingCourse, type ChaoxingVideo } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { useDownloads } from "@/stores/downloads";

type Step = "checking" | "login" | "courses" | "listing" | "confirm";
type LoginMode = "password" | "cookie";

const FIELD =
  "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm outline-none focus:border-[var(--focus-ring)]";

/** 按章分组，保持原来的顺序。 */
function groupByChapter(videos: ChaoxingVideo[]): { chapter: string; videos: ChaoxingVideo[] }[] {
  const groups: { chapter: string; videos: ChaoxingVideo[] }[] = [];
  for (const video of videos) {
    const last = groups[groups.length - 1];
    if (last && last.chapter === video.chapter) last.videos.push(video);
    else groups.push({ chapter: video.chapter, videos: [video] });
  }
  return groups;
}

/**
 * 超星 / 学习通导入：登录（账号密码，或粘贴 Cookie）→ 选一门课 → 勾选视频 → 交给下载队列。
 * 只存登录后的 Cookie，不存密码。
 */
export function ChaoxingImportDialog({
  courseId,
  onClose,
  returnFocusRef,
}: {
  courseId: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [step, setStep] = useState<Step>("checking");
  const [mode, setMode] = useState<LoginMode>("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [cookies, setCookies] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [courses, setCourses] = useState<ChaoxingCourse[]>([]);
  const [course, setCourse] = useState<ChaoxingCourse | null>(null);
  const [videos, setVideos] = useState<ChaoxingVideo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const requestRef = useRef("");

  // 存着 Cookie 就直接去列课程；失效了后端会清掉 Cookie、这里回到登录。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { loggedIn } = await ipc.chaoxing.status();
        if (!alive) return;
        if (!loggedIn) {
          setStep("login");
          return;
        }
        const list = await ipc.chaoxing.courses();
        if (!alive) return;
        setCourses(list);
        setStep("courses");
      } catch (err) {
        if (!alive) return;
        setError(err);
        setStep("login");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ requestId: string; done: number; total: number }>(
      "chaoxing:list-progress",
      (event) => {
        if (event.payload.requestId !== requestRef.current) return;
        setProgress({ done: event.payload.done, total: event.payload.total });
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  async function login() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const list =
        mode === "password"
          ? await ipc.chaoxing.login(username.trim(), password)
          : await ipc.chaoxing.setCookies(cookies);
      setPassword("");
      setCourses(list);
      setStep("courses");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setError(null);
    try {
      await ipc.chaoxing.logout();
    } catch {
      // 清不掉也回到登录：下次登录会覆盖。
    }
    setCourses([]);
    setStep("login");
  }

  async function openCourse(next: ChaoxingCourse) {
    setCourse(next);
    setError(null);
    setProgress(null);
    setStep("listing");
    const requestId = `${next.clazzId}-${Date.now()}`;
    requestRef.current = requestId;
    try {
      const list = await ipc.chaoxing.courseVideos(next, requestId);
      if (requestRef.current !== requestId) return;
      setVideos(list);
      setSelected(new Set(list.map((video) => video.url)));
      setStep("confirm");
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(err);
      // 后端的失效提示是固定的一句（`chaoxing::LOGIN_EXPIRED`），Cookie 已经被它清掉了。
      const expired = String(err).includes("超星登录已失效");
      setStep(expired ? "login" : "courses");
    }
  }

  const groups = useMemo(() => groupByChapter(videos), [videos]);
  const allSelected = videos.length > 0 && selected.size === videos.length;

  const toggle = (urls: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const url of urls) {
        if (on) next.add(url);
        else next.delete(url);
      }
      return next;
    });

  async function runImport() {
    const picked = videos.filter((video) => selected.has(video.url));
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const jobs = await ipc.downloads.enqueue(
        courseId,
        picked.map((video) => ({ url: video.url, title: video.title })),
      );
      useDownloads.getState().addMany(jobs);
      void queryClient.invalidateQueries({ queryKey: qk.videos.list(courseId) });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || step === "listing";

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      locked={locked}
      title={t("chaoxingImport.title")}
      titleClassName="mb-3 flex-none"
      size="lg"
      className="flex flex-col"
      returnFocusTo={() => returnFocusRef?.current ?? restoreFocusRef.current}
    >
      {step === "checking" && (
        <p role="status" className="py-6 text-center text-sm text-[var(--text-muted)]">
          {t("chaoxingImport.checking")}
        </p>
      )}

      {step === "login" && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <div role="tablist" aria-label={t("chaoxingImport.loginMode")} className="flex gap-1.5">
            {(["password", "cookie"] as const).map((one) => (
              <button
                key={one}
                type="button"
                role="tab"
                aria-selected={mode === one}
                onClick={() => {
                  setMode(one);
                  setError(null);
                }}
                className={`ca-touch-44 rounded-md px-2.5 py-1 text-xs ${
                  mode === one
                    ? "bg-[var(--surface-card-hover)] font-medium text-[var(--text-strong)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
                }`}
              >
                {t(one === "password" ? "chaoxingImport.byPassword" : "chaoxingImport.byCookie")}
              </button>
            ))}
          </div>
          {mode === "password" ? (
            <>
              <input
                aria-label={t("chaoxingImport.username")}
                placeholder={t("chaoxingImport.username")}
                autoComplete="username"
                autoFocus
                className={FIELD}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <input
                aria-label={t("chaoxingImport.password")}
                placeholder={t("chaoxingImport.password")}
                type="password"
                autoComplete="current-password"
                className={FIELD}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-xs leading-relaxed text-[var(--text-muted)]">{t("chaoxingImport.passwordHint")}</p>
            </>
          ) : (
            <>
              <textarea
                aria-label={t("chaoxingImport.cookie")}
                placeholder="fid=…; _uid=…; UID=…; vc3=…"
                rows={4}
                spellCheck={false}
                className={`${FIELD} font-[var(--font-mono)] text-xs`}
                value={cookies}
                onChange={(event) => setCookies(event.target.value)}
              />
              <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-[var(--text-muted)]">
                <li>{t("chaoxingImport.cookieStep1")}</li>
                <li>{t("chaoxingImport.cookieStep2")}</li>
                <li>{t("chaoxingImport.cookieStep3")}</li>
              </ol>
            </>
          )}
          {error != null && <ErrorNote error={error} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={busy || (mode === "password" ? !username.trim() || !password : !cookies.trim())}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("chaoxingImport.login")}
            </Button>
          </div>
        </form>
      )}

      {step === "courses" && (
        <>
          <div className="mb-2 flex flex-none items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-muted)]">
              {t("chaoxingImport.courseCount", { count: courses.length })}
            </span>
            <button
              type="button"
              className="ca-hit-expand text-xs text-[var(--text-muted)] underline-offset-2 hover:underline"
              onClick={() => void logout()}
            >
              {t("chaoxingImport.logout")}
            </button>
          </div>
          {courses.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">{t("chaoxingImport.noCourses")}</p>
          ) : (
            <ul className="ca-thin-scroll mb-3 min-h-0 flex-1 space-y-0.5 overflow-auto rounded-lg border border-[var(--border-subtle)] p-1.5">
              {courses.map((one) => (
                <li key={`${one.courseId}-${one.clazzId}`}>
                  <button
                    type="button"
                    onClick={() => void openCourse(one)}
                    className="ca-touch-44 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--surface-card-hover)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-[var(--font-display)] text-sm text-[var(--text-strong)]">
                        {one.title}
                      </span>
                      {one.teacher && (
                        <span className="block truncate text-xs text-[var(--text-muted)]">{one.teacher}</span>
                      )}
                    </span>
                    <ChevronRight className="h-4 w-4 flex-none text-[var(--text-faint)]" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error != null && <ErrorNote className="mb-3" error={error} />}
          <div className="flex flex-none justify-end">
            <Button size="sm" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      )}

      {step === "listing" && (
        <p role="status" aria-live="polite" className="py-6 text-center text-sm text-[var(--text-muted)]">
          {progress && progress.total > 0
            ? t("chaoxingImport.listingProgress", { done: progress.done, total: progress.total })
            : t("chaoxingImport.listing", { title: course?.title ?? "" })}
        </p>
      )}

      {step === "confirm" && course && (
        <>
          <p className="mb-2 flex-none truncate font-[var(--font-display)] text-sm text-[var(--text-strong)]">
            {course.title}
          </p>
          {videos.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">{t("chaoxingImport.noVideos")}</p>
          ) : (
            <>
              <div className="mb-2 flex flex-none flex-wrap items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelected(allSelected ? new Set() : new Set(videos.map((v) => v.url)))}
                >
                  {allSelected ? t("playlistImport.deselectAll") : t("playlistImport.selectAll")}
                </Button>
                <span className="font-[var(--font-mono)] text-xs text-[var(--text-muted)]">
                  {t("playlistImport.selected", { selected: selected.size, total: videos.length })}
                </span>
              </div>
              <div className="ca-thin-scroll mb-3 min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border-subtle)] p-1.5">
                {groups.map((group, index) => {
                  const urls = group.videos.map((video) => video.url);
                  const groupOn = urls.every((url) => selected.has(url));
                  return (
                    <div key={`${group.chapter}-${index}`} className="mb-1">
                      {group.chapter && (
                        <label className="flex cursor-pointer items-center gap-2 px-2 pb-0.5 pt-1.5 text-xs font-medium text-[var(--text-muted)]">
                          <input
                            type="checkbox"
                            checked={groupOn}
                            onChange={() => toggle(urls, !groupOn)}
                            className="h-3.5 w-3.5 flex-none accent-[var(--accent-text)]"
                          />
                          <span className="truncate">{group.chapter}</span>
                        </label>
                      )}
                      {group.videos.map((video) => (
                        <label
                          key={video.url}
                          className={`flex cursor-pointer items-center gap-2 rounded py-1.5 pr-2 text-sm hover:bg-[var(--surface-card-hover)] ${group.chapter ? "pl-6" : "pl-2"}`}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(video.url)}
                            onChange={() => toggle([video.url], !selected.has(video.url))}
                            className="h-3.5 w-3.5 flex-none accent-[var(--accent-text)]"
                          />
                          <span title={video.title} className="truncate text-[var(--text-normal)]">
                            {video.title}
                          </span>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {error != null && <ErrorNote className="mb-3" error={error} />}
          <div className="flex flex-none flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setStep("courses")}>
              {t("playlistImport.back")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || selected.size === 0}
              onClick={() => void runImport()}
            >
              {busy ? t("playlistImport.queuing") : t("playlistImport.importCount", { count: selected.size })}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

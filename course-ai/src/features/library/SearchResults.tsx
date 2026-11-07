import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Folder as FolderIcon } from "lucide-react";
import type { Folder, SearchHit } from "@/lib/types";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { VideoCover } from "./VideoCover";
import { folderPath } from "./folderTree";

/** 把文本里与关键词相同的片段（英文不分大小写）包成 <mark>。 */
function highlight(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  while (at >= 0) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
}

/**
 * 课程页的搜索结果：每个视频一行，下面列出在笔记、文稿里的命中上下文。
 * 点视频打开它；点某条文稿命中直接跳到那一刻。
 */
export function SearchResults({
  hits,
  query,
  folders,
  currentFolderId,
  onOpen,
  onOpenAt,
}: {
  hits: SearchHit[];
  query: string;
  folders: Folder[];
  /** 当前所在层：结果的路径只显示这一层以下的部分。 */
  currentFolderId: string | null;
  onOpen: (videoId: string) => void;
  onOpenAt: (videoId: string, ms: number) => void;
}) {
  const { t } = useTranslation();
  const base = folderPath(folders, currentFolderId).length;

  return (
    <ul className="ca-search-results" aria-label={t("search.results")}>
      {hits.map((hit) => {
        const path = folderPath(folders, hit.folder_id).slice(base);
        const more = hit.transcript_count - hit.transcript_hits.length;
        return (
          <li key={hit.video_id} className="ca-search-hit">
            <button
              type="button"
              className="ca-search-head"
              aria-label={t("home.openVideo", { title: displayTitle(hit.title) })}
              onClick={() => onOpen(hit.video_id)}
            >
              <span className="row-thumb">
                <VideoCover videoId={hit.video_id} className="absolute inset-0 h-full w-full" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="ca-search-title">{highlight(displayTitle(hit.title), query)}</span>
                {path.length > 0 && (
                  <span className="ca-search-path">
                    <FolderIcon aria-hidden="true" className="h-3 w-3 flex-none" />
                    {path.map((folder) => folder.name).join(" › ")}
                  </span>
                )}
              </span>
            </button>
            {hit.note_snippet && (
              <p className="ca-search-line">
                <span className="ca-search-tag">{t("search.inNotes")}</span>
                <span className="min-w-0">{highlight(hit.note_snippet, query)}</span>
              </p>
            )}
            {hit.transcript_hits.map((line) => (
              <button
                key={line.start_ms}
                type="button"
                className="ca-search-line ca-search-jump"
                aria-label={t("search.jumpTo", {
                  time: formatMs(line.start_ms),
                  title: displayTitle(hit.title),
                })}
                onClick={() => onOpenAt(hit.video_id, line.start_ms)}
              >
                <span className="ca-search-tag tabular-nums">{formatMs(line.start_ms)}</span>
                <span className="min-w-0">{highlight(line.snippet, query)}</span>
              </button>
            ))}
            {more > 0 && <p className="ca-search-more">{t("search.moreInTranscript", { count: more })}</p>}
          </li>
        );
      })}
    </ul>
  );
}

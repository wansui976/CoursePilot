import { Fragment } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { withClickableTimestamps } from "@/lib/clickableTimestamps";
import { usePlayer } from "@/stores/player";
import { TextSkeleton } from "@/components/ui/skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PanelActions } from "./PanelActions";

/** 极简 Markdown 渲染：## 小标题、- 列表、空行分段、**加粗**、[mm:ss] 跳转。够摘要用，避免再引依赖。 */
function renderMarkdown(md: string, onSeek: (ms: number) => void) {
  const lines = md.split("\n");
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-2 list-disc space-y-1 pl-5">
        {bullets.map((b, i) => (
          <li key={i} className="text-sm leading-relaxed text-[var(--text-normal)]">
            {renderInline(b, onSeek)}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushBullets();
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      bullets.push(line.slice(2));
      continue;
    }
    flushBullets();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(
        <h4
          key={`h-${blocks.length}`}
          className="mt-4 mb-1 text-sm font-semibold text-[var(--text-strong)]"
        >
          {renderInline(heading[1], onSeek)}
        </h4>,
      );
    } else {
      blocks.push(
        <p key={`p-${blocks.length}`} className="my-2 text-sm leading-relaxed text-[var(--text-normal)]">
          {renderInline(line, onSeek)}
        </p>,
      );
    }
  }
  flushBullets();
  return blocks;
}

function renderInline(text: string, onSeek: (ms: number) => void) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold text-[var(--text-strong)]">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <Fragment key={i}>{withClickableTimestamps(part, onSeek, `s-${i}`)}</Fragment>
    ),
  );
}

export function SummaryPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const { data: summary, isLoading } = useQuery({
    queryKey: ["summary", videoId],
    queryFn: () => ipc.ai.getSummary(videoId),
  });
  const generate = useMutation({
    mutationFn: () => ipc.ai.generate(videoId, "summary"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["summary", videoId] }),
  });

  return (
    <div className="relative flex max-h-[45%] shrink-0 flex-col border-b border-[var(--border-subtle)]">
      <div className="shrink-0 px-3 pt-2 text-sm text-[var(--text-muted)]">整体摘要</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-12 pt-1">
        {generate.isError && (
          <ErrorNote
            className="mb-2"
            error={generate.error}
            onRetry={() => generate.mutate()}
          />
        )}
        {isLoading ? (
          <TextSkeleton lines={5} className="p-0" />
        ) : summary ? (
          renderMarkdown(summary, requestSeek)
        ) : (
          <p className="text-sm text-[var(--text-faint)]">
            还没有摘要，字幕就绪后会自动生成，也可点右下角重新生成。
          </p>
        )}
      </div>
      <PanelActions
        onRegenerate={() => generate.mutate()}
        regenerating={generate.isPending}
        hasContent={!!summary}
      />
    </div>
  );
}

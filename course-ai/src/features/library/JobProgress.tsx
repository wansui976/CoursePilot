import { useEffect } from "react";
import { qk } from "@/lib/queryKeys";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { useJobs, type JobUpdate } from "@/stores/jobs";
import { ErrorNote } from "@/ui/ErrorNote";

// 流水线顺序（与后端 jobs::STAGES 对应）。
const STAGE_ORDER = [
  "audio",
  "asr",
  "slides",
  "slides_ocr",
  "chapters",
  "summary",
  "notes",
  "quiz",
  "mindmap",
];
const STAGE_KEYS: Record<string, string> = {
  audio: "job.audio",
  asr: "job.asr",
  slides: "job.slides",
  slides_ocr: "job.slides_ocr",
  chapters: "job.chapters",
  summary: "job.summary",
  notes: "job.notes",
  quiz: "job.quiz",
  mindmap: "job.mindmap",
};
const STATUS_KEYS: Record<string, string> = {
  pending: "job.pending",
  running: "job.running",
  done: "job.done",
  failed: "job.failed",
  canceled: "job.canceled",
};

function stageRank(stage: string): number {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? STAGE_ORDER.length : i;
}

const EMPTY_JOBS: Record<string, JobUpdate> = {};

export function JobProgress({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const jobs = useJobs((s) => s.byVideo[videoId] ?? EMPTY_JOBS);
  const setOne = useJobs((s) => s.setOne);

  const jobsQuery = useQuery({
    queryKey: qk.pipelineJobs(videoId),
    queryFn: () => ipc.pipeline.jobs(videoId),
  });

  useEffect(() => {
    jobsQuery.data?.forEach((job) =>
      setOne({
        video_id: job.video_id,
        job_id: job.id,
        stage: job.stage,
        status: job.status,
        progress: job.progress,
        message: job.message,
      }),
    );
  }, [jobsQuery.data, setOne]);

  const process = useMutation({
    mutationKey: ["pipeline-process", videoId],
    mutationFn: () => ipc.pipeline.process(videoId),
    onSuccess: () => jobsQuery.refetch(),
  });

  if (jobsQuery.isLoading) {
    return (
      <p
        role="status"
        className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
      >
        <Loader2
          aria-hidden="true"
          className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
        />
        {t("job.loading")}
      </p>
    );
  }

  if (jobsQuery.isError) {
    return (
      <ErrorNote
        error={jobsQuery.error}
        onRetry={() => void jobsQuery.refetch()}
      />
    );
  }

  const list = Object.values(jobs).sort(
    (a, b) => stageRank(a.stage) - stageRank(b.stage),
  );
  const hasFailed = list.some((job) => job.status === "failed");
  const actionLabel = process.isPending
    ? hasFailed
      ? t("job.retrying")
      : t("job.starting")
    : hasFailed
      ? t("job.retry")
      : t("job.start");
  const action = (
    <button
      type="button"
      disabled={process.isPending}
      className="inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-2 py-0.5 text-xs text-primary hover:bg-[var(--surface-card)] disabled:cursor-not-allowed disabled:opacity-60"
      onClick={() => process.mutate()}
    >
      {process.isPending ? (
        <Loader2
          aria-hidden="true"
          className="h-3 w-3 animate-spin motion-reduce:animate-none"
        />
      ) : hasFailed ? (
        <RefreshCw aria-hidden="true" className="h-3 w-3" />
      ) : (
        <Play aria-hidden="true" className="h-3 w-3" />
      )}
      {actionLabel}
    </button>
  );

  if (list.length === 0) {
    return (
      <div className="space-y-2">
        {process.isError ? (
          <ErrorNote error={process.error} onRetry={() => process.mutate()} />
        ) : (
          <p className="text-xs text-[var(--text-faint)]">
            {t("job.notStarted")}
          </p>
        )}
        {!process.isError && action}
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {process.isError ? (
        <li>
          <ErrorNote
            error={process.error}
            onRetry={() => process.mutate()}
          />
        </li>
      ) : hasFailed ? (
        <li className="flex justify-end">
          {action}
        </li>
      ) : null}
      {list.map((job) => (
        <li key={job.stage} className="text-xs">
          <div className="flex justify-between">
            <span>{STAGE_KEYS[job.stage] ? t(STAGE_KEYS[job.stage]) : job.stage}</span>
            <span
              className={job.status === "failed" ? "text-[var(--status-err)]" : "text-[var(--text-muted)]"}
            >
              {STATUS_KEYS[job.status] ? t(STATUS_KEYS[job.status]) : job.status} {Math.floor(job.progress * 100)}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded bg-[var(--surface-card-hover)]">
            <div
              className="ca-fill-grad h-1"
              style={{ width: `${job.progress * 100}%` }}
            />
          </div>
          {job.message && <p className="text-[var(--text-faint)]">{job.message}</p>}
        </li>
      ))}
    </ul>
  );
}

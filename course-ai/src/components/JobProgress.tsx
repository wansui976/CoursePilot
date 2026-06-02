import { useEffect } from "react";
import { ipc } from "@/lib/ipc";
import { useJobs, type JobUpdate } from "@/stores/jobs";

const STAGE_LABEL: Record<string, string> = {
  audio: "提取音频",
  asr: "语音识别",
};

const EMPTY_JOBS: Record<string, JobUpdate> = {};

export function JobProgress({ videoId }: { videoId: string }) {
  const jobs = useJobs((s) => s.byVideo[videoId] ?? EMPTY_JOBS);
  const setOne = useJobs((s) => s.setOne);

  useEffect(() => {
    void ipc.pipeline.jobs(videoId).then((rows) => {
      rows.forEach((job) =>
        setOne({
          video_id: job.video_id,
          job_id: job.id,
          stage: job.stage,
          status: job.status,
          progress: job.progress,
          message: job.message,
        }),
      );
    });
  }, [setOne, videoId]);

  const list = Object.values(jobs).sort((a, b) =>
    a.stage.localeCompare(b.stage),
  );
  if (list.length === 0) return <p className="text-xs text-[var(--text-faint)]">未开始</p>;

  const hasFailed = list.some((job) => job.status === "failed");

  return (
    <ul className="space-y-1">
      {hasFailed && (
        <li className="flex justify-end">
          <button
            className="rounded border border-[var(--border-subtle)] px-2 py-0.5 text-xs text-primary hover:bg-[var(--surface-card)]"
            onClick={() => void ipc.pipeline.process(videoId)}
          >
            重试
          </button>
        </li>
      )}
      {list.map((job) => (
        <li key={job.stage} className="text-xs">
          <div className="flex justify-between">
            <span>{STAGE_LABEL[job.stage] ?? job.stage}</span>
            <span
              className={job.status === "failed" ? "text-red-400" : "text-[var(--text-muted)]"}
            >
              {job.status} {Math.floor(job.progress * 100)}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded bg-[var(--surface-card-hover)]">
            <div
              className="h-1 bg-primary"
              style={{ width: `${job.progress * 100}%` }}
            />
          </div>
          {job.message && <p className="text-[var(--text-faint)]">{job.message}</p>}
        </li>
      ))}
    </ul>
  );
}

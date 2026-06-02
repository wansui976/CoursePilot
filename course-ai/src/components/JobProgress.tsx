import { useEffect } from "react";
import { ipc } from "@/lib/ipc";
import { useJobs, type JobUpdate } from "@/stores/jobs";

// 流水线顺序与中文标签（与后端 jobs::STAGES 对应）。
const STAGE_ORDER = ["audio", "asr", "chapters", "notes"];
const STAGE_LABEL: Record<string, string> = {
  audio: "提取音频",
  asr: "语音识别",
  chapters: "生成章节",
  notes: "生成笔记",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  running: "进行中",
  done: "完成",
  failed: "失败",
  canceled: "已跳过",
};

function stageRank(stage: string): number {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? STAGE_ORDER.length : i;
}

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

  const list = Object.values(jobs).sort(
    (a, b) => stageRank(a.stage) - stageRank(b.stage),
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
              {STATUS_LABEL[job.status] ?? job.status} {Math.floor(job.progress * 100)}%
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

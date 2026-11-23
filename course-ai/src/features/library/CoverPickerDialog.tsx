import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { DRAWN_KINDS, type CourseCover, type CoverKind } from "@/lib/coverKind";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import type { Course } from "@/lib/types";
import { useCourseCovers } from "@/lib/useCourseCover";
import { BoardCover } from "@/ui/BoardCover";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/dialog";
import { ErrorNote } from "@/ui/ErrorNote";

/**
 * 选一门课的黑板封面：现成的学科图、AI 画的图（有的话）、通用黑板，或者让 AI 重新判断。
 * 在这里做的选择会同步到其它设备；AI 自动判断的结果不会盖掉它。
 */
export function CoverPickerDialog({ course, onClose }: { course: Course; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: covers } = useCourseCovers();
  const saved = covers?.get(course.id);

  function store(cover: CourseCover) {
    queryClient.setQueryData<CourseCover[]>(qk.courseCovers(), (list = []) => [
      ...list.filter((item) => item.course_id !== course.id),
      cover,
    ]);
  }

  const choose = useMutation({
    mutationFn: (kind: CoverKind) => ipc.courses.setCoverKind(course.id, kind),
    onSuccess: (cover) => {
      store(cover);
      onClose();
    },
  });
  const rejudge = useMutation({
    mutationFn: () => ipc.courses.classifyCover(course.id, true),
    onSuccess: store,
  });

  const options: CoverKind[] = [
    ...(saved?.art && saved.art.length > 0 ? (["custom"] as const) : []),
    ...DRAWN_KINDS,
    "generic",
  ];

  return (
    <Modal
      open
      size="xl"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("cover.title", { course: course.name })}
      description={
        saved
          ? t(saved.source === "user" ? "cover.sourceUser" : "cover.sourceAi", { kind: t(`cover.kinds.${saved.kind}`) })
          : t("cover.sourceGuess")
      }
    >
      {(choose.isError || rejudge.isError) && <ErrorNote error={choose.error ?? rejudge.error} />}
      <ul className="ca-cover-picker" aria-label={t("cover.optionsLabel")}>
        {options.map((kind) => (
          <li key={kind}>
            <button
              type="button"
              aria-pressed={saved?.kind === kind}
              disabled={choose.isPending}
              onClick={() => choose.mutate(kind)}
            >
              <BoardCover
                kind={kind}
                art={kind === "custom" ? saved?.art : null}
                terms={saved?.terms}
                seed={course.name}
                color={course.color}
                number={course.video_count}
                unit={t("library.lectureUnit")}
                className="ca-cover-picker-board"
              />
              <span>{t(`cover.kinds.${kind}`)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="default" size="sm" disabled={rejudge.isPending} onClick={() => rejudge.mutate()}>
          <Sparkles />
          {rejudge.isPending ? t("cover.judging") : t("cover.rejudge")}
        </Button>
      </div>
    </Modal>
  );
}

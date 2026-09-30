import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import type { VideoListItem } from "@/lib/types";
import { invalidateStaleArtifacts } from "@/lib/useStaleArtifacts";

/**
 * 「仅重新纠错」这一付费请求的状态。放在 Home 实例化而非课程库视图里：打开视频时
 * 课程库会卸载，而请求期间切走又回到原课程时，失败反馈仍要留在课程库里。
 */
export function useRecorrection({
  selectedCourseId,
  selectedVideoId,
  videos,
}: {
  selectedCourseId: string | null;
  selectedVideoId: string | null;
  videos: VideoListItem[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 已有字幕时「仅重新纠错」：不重新识别，回到原始稿后重跑 AI 纠错，完成后刷新文稿。
  const recorrect = useMutation({
    mutationFn: (target: { videoId: string; courseId: string }) =>
      ipc.pipeline.recorrect(target.videoId),
    onSuccess: (_d, target) => {
      queryClient.invalidateQueries({ queryKey: qk.transcripts(target.videoId) });
      // 纠错重写了整份文稿：各 AI 产物据此重新判断是否已过期。
      invalidateStaleArtifacts(queryClient, target.videoId);
    },
  });
  const resetRecorrect = recorrect.reset;
  const recorrectPendingRef = useRef(recorrect.isPending);
  const resetRecorrectWhenSettled = useRef(false);
  recorrectPendingRef.current = recorrect.isPending;
  useEffect(() => {
    // reset 只清 observer，不会取消已经发出的付费请求。进行中切课程/视频时先隐藏
    // 当前作用域，等请求真正收口再清；否则 hook 会提前回 idle，菜单能够重复发同一请求。
    if (recorrectPendingRef.current) {
      resetRecorrectWhenSettled.current = true;
    } else {
      resetRecorrect();
    }
  }, [resetRecorrect, selectedCourseId, selectedVideoId]);
  useEffect(() => {
    if (recorrect.isPending || !resetRecorrectWhenSettled.current) return;
    resetRecorrectWhenSettled.current = false;
    // 请求期间可能切走又回到原课程。此时结果仍属于眼前作用域，失败反馈要留下；
    // 只有收口时仍在其他课程/视频里，才清掉已经不可见的 mutation 状态。
    const backInTargetLibrary =
      !selectedVideoId && recorrect.variables?.courseId === selectedCourseId;
    if (!backInTargetLibrary) resetRecorrect();
  }, [
    recorrect.isPending,
    recorrect.variables,
    resetRecorrect,
    selectedCourseId,
    selectedVideoId,
  ]);
  // 纠错失败原来没有任何地方接：菜单点完就收起，既没有报错也没有变化，看起来就像没点上——
  // 而没配大模型、批次全失败、快照对不上都会走到这里。
  const recorrectTarget =
    recorrect.isError &&
    recorrect.variables &&
    videos.some(
      (video) =>
        video.id === recorrect.variables?.videoId &&
        video.course_id === recorrect.variables?.courseId &&
        video.course_id === selectedCourseId,
    )
      ? recorrect.variables
      : null;
  const recorrectError = recorrectTarget ? recorrect.error : null;

  async function requestRecorrection(video: VideoListItem) {
    const confirmed = await confirmDialog(t("home.reCorrectConfirm"), {
      title: t("home.reCorrectConfirmTitle"),
      kind: "warning",
      okLabel: t("home.reCorrectConfirmAction"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;
    recorrect.mutate({ videoId: video.id, courseId: video.course_id });
  }

  return { recorrect, recorrectTarget, recorrectError, requestRecorrection };
}

export type Recorrection = ReturnType<typeof useRecorrection>;

import type { QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { isMobile, shareFile } from "@/lib/mobileFiles";
import { qk } from "@/lib/queryKeys";
import type { Course, Video } from "@/lib/types";
import { canvasToPngBase64, type CardHeader, type ShareCardLabels } from "@/lib/shareCard/render";
import { displayTitle } from "@/lib/videoTitle";

/**
 * 分享图页眉需要的课程名与视频标题。点导出时从查询缓存里找（课程库、视频列表打开工作台
 * 时早已加载过）——不订阅路由，也不额外发请求；找不到就留空，图照样能画。
 */
export function shareCardHeader(queryClient: QueryClient, videoId: string, kind: string): CardHeader {
  const lists = queryClient.getQueriesData<Video[]>({ queryKey: qk.videos.all() });
  const video = lists.flatMap(([, videos]) => videos ?? []).find((v) => v.id === videoId);
  const courses = queryClient.getQueryData<Course[]>(qk.courses()) ?? [];
  const course = video ? courses.find((c) => c.id === video.course_id) : undefined;
  return { course: course?.name ?? "", title: video ? displayTitle(video.title) : "", kind };
}

export function useShareCardLabels(): ShareCardLabels {
  const { t } = useTranslation();
  return { tagline: t("shareCard.tagline"), truncated: t("shareCard.truncated") };
}

/**
 * 把画好的分享图存盘：桌面端存进导出目录并用系统看图打开，移动端走系统分享。
 * 返回落地路径（导出菜单拿它做「已导出」反馈）。
 */
export async function saveShareCard(
  canvas: HTMLCanvasElement,
  { videoId, fileName }: { videoId: string | null; fileName: string },
): Promise<string> {
  const mobile = isMobile();
  const path = await ipc.export.shareImage(videoId, fileName, canvasToPngBase64(canvas), !mobile);
  if (mobile) await shareFile(path, "image/png");
  return path;
}

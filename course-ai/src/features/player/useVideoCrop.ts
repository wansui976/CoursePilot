import { useQuery } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ipc } from "@/lib/ipc";
import {
  NO_INSETS,
  contentAspect,
  resolveCrop,
  type Box,
  type Insets,
} from "@/lib/blackBars";

/** 每视频的去黑边偏好。默认自动（开），只有用户显式关掉的才记 localStorage。
 *  从全局开关改成按视频：不同的片子黑边情况不一样，不该一刀切。 */
function cropEnabledFor(videoId: string): boolean {
  try {
    return localStorage.getItem(`crop-black-bars:${videoId}`) !== "off";
  } catch {
    return true;
  }
}

function setCropEnabledFor(videoId: string, enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(`crop-black-bars:${videoId}`);
    else localStorage.setItem(`crop-black-bars:${videoId}`, "off");
  } catch {
    // 隐私模式下写不了，本次会话内照常工作。
  }
}

/** 把四边占比写成人能读的字符串（按当前语言）。 */
export function formatInsetsText(t: TFunction, insets: Insets): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  return `${t("videoPlayer.cropTop")} ${pct(insets.top)} / ${t("videoPlayer.cropRight")} ${pct(
    insets.right,
  )} / ${t("videoPlayer.cropBottom")} ${pct(insets.bottom)} / ${t(
    "videoPlayer.cropLeft",
  )} ${pct(insets.left)}`;
}

/**
 * 去黑边的全部状态与几何，从播放器里抽出来单放。
 *
 * 探测在后台跑（见后端 `spawn_crop_detection`），这里只负责：
 *  - 查询结果（已缓存立即返回；没测过且可播放时后台起任务，`detecting` 期间轮询）；
 *  - 切走视频时取消探测；
 *  - 把探测到的四边换算成真正套到 `<video>` 上的裁剪样式（stageBox + cropStyle 的输入）。
 *
 * `markMetadata` / `markPlayable` 由 VideoPlayer 从 video 元素事件喂进来
 * （`videoAspect` 需要 `videoWidth/videoHeight`，探测要等画面能放了再进场，不和起播抢）。
 */
export function useVideoCrop(
  videoId: string,
  regionRef: React.RefObject<HTMLDivElement | null>,
) {
  const { t } = useTranslation();
  const [cropOn, setCropOn] = useState(() => cropEnabledFor(videoId));
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const [videoMetadataReady, setVideoMetadataReady] = useState(false);
  const [playbackReady, setPlaybackReady] = useState(false);
  const [region, setRegion] = useState({ w: 0, h: 0 });
  const [cropNotice, setCropNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!cropNotice) return;
    const timer = setTimeout(() => setCropNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [cropNotice]);

  // 探测结果查询。已测过立即返回；没测过且在播放中就后台起任务（后端去重），
  // detecting=true 期间每 2s 轮询，直到 insets 落地。
  const { data: status } = useQuery({
    queryKey: qk.videoCrop(videoId),
    queryFn: () => ipc.videos.ensureCrop(videoId),
    enabled: cropOn && playbackReady,
    refetchInterval: (query) => (query.state.data?.detecting ? 2000 : false),
    staleTime: Infinity,
    retry: false,
  });
  const detecting = status?.detecting ?? false;
  const cropInsets = status?.insets ?? NO_INSETS;

  // 切走/关掉播放器就停掉探测：结果没人要了，留着只会压在新视频起播上。
  useEffect(
    () => () => {
      void ipc.videos.cancelCropDetect(videoId).catch(() => {});
    },
    [videoId],
  );

  // 量舞台尺寸：stageBox 按它做等比缩放。窗口拖拽/面板变化时随之更新。
  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      setRegion((prev) =>
        Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5
          ? prev
          : { w: width, h: height },
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [regionRef]);

  const markMetadata = (videoWidth: number, videoHeight: number) => {
    if (videoWidth > 0 && videoHeight > 0) setVideoAspect(videoWidth / videoHeight);
    setVideoMetadataReady(true);
  };
  const markPlayable = () => setPlaybackReady(true);

  // 去黑边是猜出来的，猜错时画面会显得被裁掉一块；关掉开关就回到原封不动的画面，
  // 好分清「源片本来如此」还是「我们裁歪了」。每侧按探测值独立裁剪（见 resolveCrop）。
  const effectiveCrop = resolveCrop(videoMetadataReady && cropOn ? cropInsets : NO_INSETS);
  const aspect =
    videoMetadataReady && videoAspect > 0
      ? contentAspect(videoAspect, effectiveCrop)
      : videoAspect > 0
        ? videoAspect
        : 16 / 9;
  const stageBox: Box | null = useMemo(() => {
    const { w, h } = region;
    if (!w || !h) return null;
    let boxW = w;
    let boxH = w / aspect;
    if (boxH > h) {
      boxH = h;
      boxW = h * aspect;
    }
    // 对齐到整数物理像素：暂停时的静态帧是按物理像素栅格化的，舞台落在半像素上会被
    // 重采样而发虚。先按 devicePixelRatio 取整再换回 CSS 像素，让缩放尽量无损。
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    return { width: snap(boxW), height: snap(boxH) };
  }, [region, aspect]);

  // 开关去黑边：开/关都打在画面上说一声。裁歪了要能分清是「探测值」还是「源片带边」。
  const toggleCrop = () => {
    const next = !cropOn;
    setCropOn(next);
    setCropEnabledFor(videoId, next);
    const insets = formatInsetsText(t, cropInsets);
    const notice = next
      ? t("videoPlayer.cropNoticeOn", { insets })
      : t("videoPlayer.cropNoticeOff", { insets });
    setCropNotice(notice);
  };

  return {
    cropOn,
    detecting,
    cropInsets,
    cropNotice,
    effectiveCrop,
    stageBox,
    toggleCrop,
    markMetadata,
    markPlayable,
  };
}

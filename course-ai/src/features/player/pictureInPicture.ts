import { useEffect, useState, type RefObject } from "react";

// 画中画：桌面端（Windows 的 WebView2 走标准 API，macOS 的 WKWebView 两套都有）和 iPhone / iPad
// （WKWebView 的 webkitSetPresentationMode）把视频弹成系统小窗，切去别的窗口 / App 还能接着看。
// Android WebView 不支持网页视频画中画，按钮不出。
//
// <video> 平时带着 disablePictureInPicture：不让 WebView2 在画面上自己浮一个画中画按钮，
// 也不让系统在不该的时候把它弹出去。用户点了我们的按钮才临时放开。

type WebkitPresentationMode = "inline" | "picture-in-picture" | "fullscreen";

interface WebkitVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: WebkitPresentationMode) => boolean;
  webkitSetPresentationMode?: (mode: WebkitPresentationMode) => void;
  webkitPresentationMode?: WebkitPresentationMode;
}

function hasWebkitPip(video: HTMLVideoElement): boolean {
  const v = video as WebkitVideo;
  return (
    typeof v.webkitSetPresentationMode === "function" &&
    typeof v.webkitSupportsPresentationMode === "function" &&
    v.webkitSupportsPresentationMode("picture-in-picture")
  );
}

function hasStandardPip(video: HTMLVideoElement): boolean {
  return (
    typeof document !== "undefined" &&
    document.pictureInPictureEnabled === true &&
    typeof video.requestPictureInPicture === "function"
  );
}

/** 这个 WebView 能不能把视频弹成画中画。 */
export function pipSupported(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  return hasStandardPip(video) || hasWebkitPip(video);
}

/** 视频此刻是不是在画中画小窗里。 */
export function isInPip(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  if (typeof document !== "undefined" && document.pictureInPictureElement === video) return true;
  return (video as WebkitVideo).webkitPresentationMode === "picture-in-picture";
}

/** 进 / 出画中画。不支持或系统拒绝时抛错，调用方给提示。 */
export async function setPip(video: HTMLVideoElement, on: boolean): Promise<void> {
  if (on === isInPip(video)) return;
  if (on) {
    video.disablePictureInPicture = false;
    if (hasStandardPip(video)) {
      try {
        await video.requestPictureInPicture();
        return;
      } catch (error) {
        // WKWebView 的标准 API 偶尔拒绝（例如还没开始缓冲），再试一次 WebKit 自己的接口。
        if (!hasWebkitPip(video)) {
          video.disablePictureInPicture = true;
          throw error;
        }
      }
    }
    if (hasWebkitPip(video)) {
      (video as WebkitVideo).webkitSetPresentationMode?.("picture-in-picture");
      return;
    }
    video.disablePictureInPicture = true;
    throw new Error("picture-in-picture is not supported");
  }
  if (typeof document !== "undefined" && document.pictureInPictureElement === video) {
    await document.exitPictureInPicture();
  } else if ((video as WebkitVideo).webkitPresentationMode === "picture-in-picture") {
    (video as WebkitVideo).webkitSetPresentationMode?.("inline");
  }
}

/**
 * 跟踪画中画状态。`key` 变了（换视频、<video> 重挂）就重新挂监听。
 * 退出画中画后把 disablePictureInPicture 放回去。
 */
export function usePictureInPicture(
  videoRef: RefObject<HTMLVideoElement | null>,
  key: unknown,
): { supported: boolean; active: boolean } {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    setSupported(pipSupported(video));
    setActive(isInPip(video));
    if (!video) return;
    const sync = () => {
      const inPip = isInPip(video);
      setActive(inPip);
      if (!inPip) video.disablePictureInPicture = true;
    };
    video.addEventListener("enterpictureinpicture", sync);
    video.addEventListener("leavepictureinpicture", sync);
    video.addEventListener("webkitpresentationmodechanged", sync);
    return () => {
      video.removeEventListener("enterpictureinpicture", sync);
      video.removeEventListener("leavepictureinpicture", sync);
      video.removeEventListener("webkitpresentationmodechanged", sync);
    };
  }, [videoRef, key]);

  return { supported, active };
}

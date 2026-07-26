import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

/**
 * 一张课件页图。页图不是普通 URL——后端要校验这条路径确实登记在该视频名下，
 * 所以走 IPC 取字节再转 object URL。课件面板与搜索结果的缩略图共用这一份。
 */
export function SlideImage({
  videoId,
  imagePath,
  alt,
  className,
}: {
  videoId: string;
  imagePath: string;
  alt: string;
  className: string;
}) {
  // 字节走 Query 缓存（staleTime: Infinity）：切 tab 重挂时不再逐张重新走 IPC。
  const { data, isError } = useQuery({
    queryKey: ["slide-image", videoId, imagePath],
    queryFn: () => ipc.slides.image(videoId, imagePath),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(data)], { type: "image/jpeg" }),
    );
    setSrc(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setSrc(null);
    };
  }, [data]);

  if (isError) {
    return (
      <div
        role="img"
        aria-label={`${alt} 加载失败`}
        className={`${className} grid place-items-center bg-[var(--status-err-bg)] text-xs text-[var(--status-err)]`}
      >
        图片加载失败
      </div>
    );
  }

  if (!src) {
    return <div aria-label={alt} className={`${className} bg-[var(--surface-card)]`} />;
  }

  return <img src={src} alt={alt} className={className} />;
}

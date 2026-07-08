import { Film } from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

/** 视频封面（首帧）。后端按需用 ffmpeg 截首帧并缓存；加载中/失败回退到图标。
 *  字节走 Query 缓存（staleTime: Infinity）：首页 ↔ 工作台切换整区重挂时，
 *  封面直接取缓存，不再每次全量走一遍 IPC。 */
export function VideoCover({
  videoId,
  className,
}: {
  videoId: string;
  className: string;
}) {
  const { data } = useQuery({
    queryKey: ["video-cover", videoId],
    queryFn: () => ipc.videos.cover(videoId),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const bytes = new Uint8Array(data);
    if (bytes.byteLength === 0) return;
    const objectUrl = URL.createObjectURL(
      new Blob([bytes], { type: "image/jpeg" }),
    );
    setSrc(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setSrc(null);
    };
  }, [data]);

  if (!src) {
    return (
      <div
        className={`flex items-center justify-center bg-[var(--surface-card-hover)] ${className}`}
      >
        <Film className="h-4 w-4 text-[var(--text-faint)]" />
      </div>
    );
  }

  return <img src={src} alt="" className={`object-cover ${className}`} />;
}

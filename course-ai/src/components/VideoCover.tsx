import { Film } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";

/** 视频封面（首帧）。后端按需用 ffmpeg 截首帧并缓存；加载中/失败回退到图标。 */
export function VideoCover({
  videoId,
  className,
}: {
  videoId: string;
  className: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSrc(null);
    ipc.videos
      .cover(videoId)
      .then((bytes) => {
        if (!active || bytes.length === 0) return;
        try {
          objectUrl = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
          );
          setSrc(objectUrl);
        } catch {
          setSrc(null);
        }
      })
      .catch(() => {
        if (active) setSrc(null);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [videoId]);

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

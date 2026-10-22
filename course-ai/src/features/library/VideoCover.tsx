import { Film } from "lucide-react";
import { useVideoCoverUrl } from "@/lib/useVideoCoverUrl";

/** 视频封面（首帧）。后端按需截首帧并缓存；加载中/失败回退到图标。 */
export function VideoCover({
  videoId,
  className,
}: {
  videoId: string;
  className: string;
}) {
  const src = useVideoCoverUrl(videoId);

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

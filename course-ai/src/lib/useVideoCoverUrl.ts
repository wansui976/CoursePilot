import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";

/** 视频封面（首帧）的 object URL；还没取到或没有封面时为 null。
 *  字节走 Query 缓存（staleTime: Infinity）：首页 ↔ 工作台切换整区重挂时，
 *  封面直接取缓存，不再每次全量走一遍 IPC。 */
export function useVideoCoverUrl(videoId: string, enabled = true): string | null {
  const { data } = useQuery({
    queryKey: qk.videoCover(videoId),
    queryFn: () => ipc.videos.cover(videoId),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    enabled,
  });
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const bytes = new Uint8Array(data);
    if (bytes.byteLength === 0) return;
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    setSrc(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setSrc(null);
    };
  }, [data]);

  return src;
}

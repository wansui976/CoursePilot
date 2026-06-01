import { open } from "@tauri-apps/plugin-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

export function ImportVideoButton({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      const file = await open({
        directory: false,
        multiple: false,
        filters: [
          { name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "m4v"] },
        ],
      });
      if (!file || Array.isArray(file)) return null;
      return ipc.videos.addLocal(courseId, file);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["videos", courseId] }),
  });

  return (
    <Button size="sm" onClick={() => mutation.mutate()}>
      + 导入视频
    </Button>
  );
}

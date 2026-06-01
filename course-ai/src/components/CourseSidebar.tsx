import { open } from "@tauri-apps/plugin-dialog";
import { Settings } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

export function CourseSidebar({
  selectedCourseId,
  onSelect,
  onOpenSettings,
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: courses = [] } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });
  const create = useMutation({
    mutationFn: async () => {
      const dir = await open({ directory: true, multiple: false });
      if (!dir || Array.isArray(dir)) return null;
      const name = dir.split(/[\\/]/).pop() || "Untitled";
      return ipc.courses.create(name, dir);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["courses"] }),
  });

  return (
    <aside className="flex h-full w-56 flex-col gap-2 border-r border-white/10 p-3">
      <Button size="sm" onClick={() => create.mutate()}>
        + 添加课程
      </Button>
      <div className="flex-1 overflow-y-auto">
        {courses.map((course) => (
          <button
            key={course.id}
            onClick={() => onSelect(course.id)}
            className={`w-full rounded px-2 py-1.5 text-left text-sm ${
              course.id === selectedCourseId ? "bg-white/10" : "hover:bg-white/5"
            }`}
          >
            {course.name}
          </button>
        ))}
        {courses.length === 0 && (
          <p className="px-2 py-4 text-xs text-white/40">还没有课程</p>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={onOpenSettings}>
        <Settings className="h-4 w-4" />
        设置
      </Button>
    </aside>
  );
}

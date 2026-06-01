import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Library, Plus, Settings } from "lucide-react";
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
    <aside className="flex h-full w-[220px] flex-col border-r border-white/10 bg-[#111]">
      <div className="border-b border-white/10 px-4 py-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/90">
          <Library className="h-4 w-4 text-primary" />
          课程库
        </div>
        <Button className="w-full" size="sm" onClick={() => create.mutate()}>
          <Plus className="h-4 w-4" />
          添加课程
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {courses.map((course) => (
          <button
            key={course.id}
            onClick={() => onSelect(course.id)}
            className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${
              course.id === selectedCourseId
                ? "bg-white/12 text-white"
                : "text-white/62 hover:bg-white/6 hover:text-white"
            }`}
          >
            <FolderOpen className="h-4 w-4 flex-shrink-0 text-white/35" />
            <span className="truncate">{course.name}</span>
          </button>
        ))}
        {courses.length === 0 && (
          <div className="px-2 py-5 text-xs leading-relaxed text-white/45">
            选择一个课程文件夹后，视频会按课程归档。
          </div>
        )}
      </div>
      <div className="border-t border-white/10 p-3">
        <Button className="w-full justify-start" size="sm" variant="ghost" onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </aside>
  );
}

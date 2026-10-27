import { useTranslation } from "react-i18next";
import { coarsePointer } from "@/lib/useContainerWidth";
import { keyLabel, useShortcuts } from "@/stores/shortcuts";
import { Tour } from "@/ui/Tour";

/**
 * 三组新手引导，各自只出现一次（见 stores/tours）：
 * - 课程库：还没有任何课程时——建课程、配大模型、问助手；
 * - 课程页：课程里还没有视频时——导入；
 * - 工作台：第一次打开视频时——学习资料、记一笔、划选文稿、专注阅读。
 * 什么时候算「该出现」由 Home 判断；锚点不在当前布局里的步骤会被跳过。
 */
export function AppTours({
  library,
  course,
  workbench,
}: {
  library: boolean;
  course: boolean;
  workbench: boolean;
}) {
  const { t } = useTranslation();
  const takeNoteKey = useShortcuts((s) => s.bindings.takeNote);
  const noteKey = keyLabel(takeNoteKey, t);
  // 触屏上多半没有键盘：改成说笔记里的「记一笔」按钮
  const touch = coarsePointer();

  return (
    <>
      <Tour
        id="library"
        enabled={library}
        steps={[
          {
            anchor: "add-course",
            title: t("tour.library.addCourse.title"),
            body: t("tour.library.addCourse.body"),
          },
          {
            anchor: "settings",
            placement: "right",
            title: t("tour.library.settings.title"),
            body: t("tour.library.settings.body"),
          },
          {
            anchor: "assistant",
            placement: "right",
            title: t("tour.library.assistant.title"),
            body: t("tour.library.assistant.body"),
          },
        ]}
      />
      <Tour
        id="course"
        enabled={course}
        steps={[
          {
            anchor: "import",
            title: t("tour.course.import.title"),
            body: t("tour.course.import.body"),
          },
        ]}
      />
      <Tour
        id="workbench"
        enabled={workbench}
        delay={1200}
        steps={[
          {
            anchor: "study-tabs",
            title: t("tour.workbench.tabs.title"),
            body: t("tour.workbench.tabs.body"),
          },
          {
            anchor: "tab-notes",
            title: touch
              ? t("tour.workbench.notesTouch.title")
              : t("tour.workbench.notes.title", { key: noteKey }),
            body: touch
              ? t("tour.workbench.notesTouch.body", { key: noteKey })
              : t("tour.workbench.notes.body"),
          },
          {
            anchor: "tab-transcript",
            title: t("tour.workbench.transcript.title"),
            body: t("tour.workbench.transcript.body"),
          },
          {
            anchor: "reading-focus",
            placement: "left",
            title: t("tour.workbench.focus.title"),
            body: t("tour.workbench.focus.body"),
          },
        ]}
      />
    </>
  );
}

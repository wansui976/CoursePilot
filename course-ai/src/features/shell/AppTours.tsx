import { useTranslation } from "react-i18next";
import type { HomeLocation } from "@/app/homeRoute";
import { isMobile } from "@/lib/platform";
import { coarsePointer } from "@/lib/useContainerWidth";
import { keyLabel, useShortcuts } from "@/stores/shortcuts";
import { Tour } from "@/ui/Tour";
import { richText } from "./tourText";

const LINKS = {
  deepseek: "https://platform.deepseek.com/",
  volcengine: "https://console.volcengine.com/speech/service/10012",
  bailian: "https://bailian.console.aliyun.com/",
};

/**
 * 三组新手引导，各自只出现一次（见 stores/tours）：
 * - 课程库：还没有任何课程时——先带着配大模型、配语音识别（会跳进设置对应的分类），
 *   最后回到课程库建课程、导入；
 * - 课程页：课程里还没有视频时——导入；
 * - 工作台：第一次打开视频时——学习资料、记一笔、划选文稿、专注阅读。
 * 什么时候算「该出现」由 Home 判断；锚点不在当前布局里的步骤会被跳过。
 */
export function AppTours({
  library,
  course,
  workbench,
  navigate,
}: {
  library: boolean;
  course: boolean;
  workbench: boolean;
  /** 跳页面。由 Home 包一层「离开设置前先问未保存的大模型配置」的保护。 */
  navigate: (patch: Partial<HomeLocation>) => void;
}) {
  const { t } = useTranslation();
  const takeNoteKey = useShortcuts((s) => s.bindings.takeNote);
  const noteKey = keyLabel(takeNoteKey, t);
  // 触屏上多半没有键盘：改成说笔记里的「记一笔」按钮
  const touch = coarsePointer();
  const mobile = isMobile();

  return (
    <>
      <Tour
        id="library"
        enabled={library}
        steps={[
          {
            anchor: "settings",
            placement: "right",
            title: t("tour.library.settings.title"),
            body: t("tour.library.settings.body"),
            onNext: () => navigate({ view: "settings", settingsCategory: "llm" }),
          },
          {
            anchor: "llm-add",
            awaitAnchor: true,
            wide: true,
            placement: "left",
            title: t("tour.library.llm.title"),
            body: t("tour.library.llm.body"),
            items: [
              richText(t("tour.library.llm.step1"), LINKS.deepseek),
              richText(t("tour.library.llm.step2")),
              richText(t("tour.library.llm.step3")),
            ],
            onNext: () => navigate({ view: "settings", settingsCategory: "asr" }),
          },
          {
            anchor: "asr-backend",
            awaitAnchor: true,
            wide: true,
            placement: "left",
            title: t("tour.library.asr.title"),
            body: mobile ? t("tour.library.asr.bodyMobile") : t("tour.library.asr.body"),
            items: [
              richText(t("tour.library.asr.volc"), LINKS.volcengine),
              richText(t("tour.library.asr.aliyun"), LINKS.bailian),
            ],
            onNext: () => navigate({ view: "library", courseId: null, videoId: null }),
          },
          {
            anchor: "add-course",
            awaitAnchor: true,
            wide: true,
            title: t("tour.library.addCourse.title"),
            items: [
              t("tour.library.addCourse.step1"),
              mobile ? t("tour.library.addCourse.step2Mobile") : t("tour.library.addCourse.step2"),
              t("tour.library.addCourse.step3"),
            ],
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

import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { parseScratch, stepMark } from "@/lib/scratch";
import { loadHandFont, useNotePaper } from "@/stores/notePaper";

/**
 * 助手回答里的一张方格草稿纸：多步推导一行一步，左边圈号，每行出来时从左往右「写」出来；
 * 写错又改的那一步划一道斜线留着；最后的答案用方框框起来，像考卷上写答案。
 * 字跟着「笔记字体」设置走（默认衬线，选了手写就用霞鹜文楷）。
 */
export function ScratchPaper({
  body,
  renderLine,
}: {
  body: string;
  /** 每行里的公式、时间戳、加粗交给外面的行内渲染。 */
  renderLine: (text: string, key: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const font = useNotePaper((state) => state.font);
  useEffect(() => {
    if (font === "hand") void loadHandFont();
  }, [font]);
  const scratch = parseScratch(body);
  let n = 0;
  return (
    <figure className="ca-scratch" data-font={font} aria-label={t("assistant.scratch")}>
      <ol className="ca-scratch-steps">
        {scratch.steps.map((step, index) => {
          const mark = step.struck ? "" : stepMark(++n);
          return (
            <li key={index} className="ca-scratch-step" data-struck={step.struck ? "" : undefined}>
              <span className="ca-scratch-mark" aria-hidden="true">
                {mark}
              </span>
              <span className="ca-scratch-text">
                {step.struck ? <s>{renderLine(step.text, `s-${index}`)}</s> : renderLine(step.text, `s-${index}`)}
              </span>
            </li>
          );
        })}
      </ol>
      {scratch.answer && (
        <p className="ca-scratch-answer">
          <span className="ca-scratch-answer-label">{t("assistant.scratchAnswer")}</span>
          {renderLine(scratch.answer, "answer")}
        </p>
      )}
    </figure>
  );
}

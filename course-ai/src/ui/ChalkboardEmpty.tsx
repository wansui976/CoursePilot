import type { ReactNode } from "react";

/**
 * 空状态写在一块黑板上：第一次打开没有课程、一门课里还没有视频时用。
 * 黑板上是粉笔字的一句话和一行补充，下面是唯一要做的那一步。没有插画、没有图标方块。
 */
export function ChalkboardEmpty({
  title,
  hint,
  steps,
  action,
}: {
  title: string;
  hint?: string;
  /** 黑板上依次写出的几步（导入一节课 → 看完 → 明天来复习）。 */
  steps?: string[];
  action?: ReactNode;
}) {
  return (
    <div className="ca-chalk-empty" role="status">
      <div className="ca-chalk-board">
        <h2 className="ca-chalk-title">{title}</h2>
        {steps && steps.length > 0 && (
          <ol className="ca-chalk-steps">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        {hint && <p className="ca-chalk-hint">{hint}</p>}
        <span className="ca-chalk-ledge" aria-hidden="true">
          <i />
          <b />
        </span>
      </div>
      {action && <div className="ca-chalk-action">{action}</div>}
    </div>
  );
}

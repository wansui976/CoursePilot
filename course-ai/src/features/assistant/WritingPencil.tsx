/**
 * 助手在「写」：一支铅笔在一行短线上来回写，身后留下一道淡淡的笔迹，写到头擦掉重来。
 * 代替转圈（发问后、正文到达前，以及调工具时）。`down` 表示这一轮失败了：铅笔放倒、不再写。
 * 纯装饰（aria-hidden），读屏状态由面板底部的 live region 播报。
 */
export function WritingPencil({ down = false }: { down?: boolean }) {
  return (
    <span className="ca-pencil-writing" data-down={down ? "" : undefined} aria-hidden="true">
      <svg viewBox="0 0 40 16" width="40" height="16" fill="none">
        {/* 笔迹：一道小波浪，靠 stroke-dashoffset 从左往右写出来。 */}
        <path
          className="ca-pencil-trail"
          d="M2 12 q3 -5 6 0 t6 0 t6 0 t6 0 t6 0"
          pathLength={100}
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        {/* 铅笔：笔尖落在笔迹的末端，跟着往右走。 */}
        <g className="ca-pencil-body">
          <path d="M0 0 l9 -9 l2.5 2.5 l-9 9 z" fill="currentColor" opacity="0.55" />
          <path d="M0 0 l2.5 2.5 l-3.4 0.9 z" fill="currentColor" />
          <path d="M9 -9 l1.3 -1.3 l2.5 2.5 l-1.3 1.3 z" fill="currentColor" opacity="0.85" />
        </g>
      </svg>
    </span>
  );
}

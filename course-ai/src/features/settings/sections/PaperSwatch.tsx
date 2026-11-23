import type { NotePaper } from "@/stores/notePaper";

const W = 120;
const H = 44;
const STEP = 11;
const range = (to: number, step: number, from = step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

/**
 * 设置里笔记纸张的小样。用 SVG 画格子（不用 CSS 渐变），在 WebKit / WebView2 / Chromium 上都画得出来；
 * 颜色走 currentColor：格线 --border-strong，横线和点 --text-faint（.strong）。
 */
export function PaperSwatch({ paper }: { paper: NotePaper }) {
  return (
    <svg className="ca-paper-swatch" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMin slice" aria-hidden="true">
      {paper === "lined" && (
        <g className="strong" stroke="currentColor" strokeWidth="1">
          {range(H - 4, STEP).map((y) => (
            <line key={y} x1="6" x2={W - 6} y1={y + 0.5} y2={y + 0.5} />
          ))}
        </g>
      )}
      {paper === "grid" && (
        <g stroke="currentColor" strokeWidth="1">
          {range(H - 1, STEP, 5).map((y) => (
            <line key={`h${y}`} x1="0" x2={W} y1={y + 0.5} y2={y + 0.5} />
          ))}
          {range(W - 1, STEP, 5).map((x) => (
            <line key={`v${x}`} y1="0" y2={H} x1={x + 0.5} x2={x + 0.5} />
          ))}
        </g>
      )}
      {paper === "dots" && (
        <g className="strong" fill="currentColor">
          {range(H - 3, STEP, 6).flatMap((y) =>
            range(W - 3, STEP, 6).map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />),
          )}
        </g>
      )}
      {paper === "mi" && (
        <>
          <g stroke="currentColor" strokeWidth="0.8" opacity="0.7">
            {range(W, 22, 0).map((x) =>
              range(H, 22, 0).map((y) => (
                <g key={`${x}-${y}`}>
                  <line x1={x} y1={y + 11} x2={x + 22} y2={y + 11} />
                  <line x1={x + 11} y1={y} x2={x + 11} y2={y + 22} />
                  <line x1={x} y1={y} x2={x + 22} y2={y + 22} />
                  <line x1={x + 22} y1={y} x2={x} y2={y + 22} />
                </g>
              )),
            )}
          </g>
          <g className="strong" stroke="currentColor" strokeWidth="1">
            {range(H, 22, 0).map((y) => (
              <line key={`h${y}`} x1="0" x2={W} y1={y + 0.5} y2={y + 0.5} />
            ))}
            {range(W, 22, 0).map((x) => (
              <line key={`v${x}`} y1="0" y2={H} x1={x + 0.5} x2={x + 0.5} />
            ))}
          </g>
        </>
      )}
    </svg>
  );
}

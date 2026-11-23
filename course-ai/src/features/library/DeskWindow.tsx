import { useTranslation } from "react-i18next";
import type { Daypart } from "@/lib/daypart";

/**
 * 课桌左上角的一扇小窗：按本地时间显示清晨、白天、黄昏、夜晚。纯装饰，设置里可以关掉。
 * 窗框是刷了漆的木头，十字窗棂；远处一道山脊，白天有太阳和云，夜里有月亮和几颗星。
 */
export function DeskWindow({ part }: { part: Daypart }) {
  const { t } = useTranslation();
  const sun = part === "day" || part === "dawn" || part === "dusk";
  const sunY = part === "day" ? 34 : 70;
  return (
    <figure className="ca-desk-window" data-part={part} aria-label={t(`desk.window.${part}`)}>
      <svg viewBox="0 0 200 140" role="img" aria-hidden="true">
        <defs>
          <linearGradient id="ca-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={`var(--sky-${part}-top)`} />
            <stop offset="1" stopColor={`var(--sky-${part}-bottom)`} />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="200" height="140" fill="url(#ca-sky)" />
        {sun ? (
          <circle cx={part === "dusk" ? 150 : 56} cy={sunY} r="13" fill="var(--sun)" opacity={part === "day" ? 0.95 : 0.85} />
        ) : (
          <>
            <path d="M150 30a14 14 0 1 0 12 22 11 11 0 1 1-12-22z" fill="var(--moon)" opacity="0.9" />
            {[
              [40, 24],
              [70, 46],
              [104, 18],
              [124, 52],
              [178, 70],
              [28, 62],
            ].map(([x, y]) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="var(--moon)" opacity="0.8" />
            ))}
          </>
        )}
        {part === "day" && (
          <g fill="var(--moon)" opacity="0.85">
            <ellipse cx="128" cy="40" rx="20" ry="7" />
            <ellipse cx="142" cy="35" rx="12" ry="7" />
            <ellipse cx="86" cy="62" rx="14" ry="5" />
          </g>
        )}
        <path d="M0 112c26-14 48-18 74-10s44 4 66-8 40-8 60 2v44H0z" fill="var(--hill)" />
      </svg>
      <span className="ca-desk-window-bars" aria-hidden="true" />
    </figure>
  );
}

import { useId } from "react";

/** 小圆环进度：value 0..1。SVG 弧线，填充段用签名渐变（--accent→亮调，即 --grad-accent
 *  的两段），中心可放子元素（如「N/M」）。换强调色自动跟随。 */
export function ProgressRing({
  value,
  size = 40,
  stroke = 4,
  className,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  className?: string;
  children?: React.ReactNode;
}) {
  // 每个实例独立 id，避免多个环共用同一 url(#…) 时 SVG 片段的 id 冲突。
  const gradId = `ca-progress-ring-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div
      className={`relative flex-none ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient
            id={gradId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={size}
            y2={size}
          >
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="color-mix(in srgb, var(--accent) 60%, #ffffff)" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-card-active)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children != null && (
        <div className="absolute inset-0 flex items-center justify-center">{children}</div>
      )}
    </div>
  );
}

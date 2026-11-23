import { useTranslation } from "react-i18next";
import type { Daypart, Season } from "@/lib/daypart";
import { moonLitPath } from "@/lib/moon";
import type { WeatherNow } from "@/lib/ipc/system";

/** 雨丝、雪片的位置：固定的一组，看起来随机，每次渲染都一样。 */
const DROPS = Array.from({ length: 26 }, (_, i) => ({ x: (i * 37 + 11) % 200, y: (i * 53 + 7) % 140 }));

/**
 * 课桌左上角的一扇小窗：天色按本地时间（清晨、白天、黄昏、夜晚），
 * 选了地点时再叠上当地的天气（多云、阴、雾、雨、雪、雷雨）。纯装饰，设置里可以关掉。
 * 窗框是刷了漆的木头，十字窗棂；远处一道山脊。
 */
export function DeskWindow({
  part,
  season = "autumn",
  moon = 0.5,
  weather,
  placeName,
}: {
  part: Daypart;
  /** 远山的颜色跟着季节。 */
  season?: Season;
  /** 夜里月亮的月相（0 新月 … 0.5 满月）。 */
  moon?: number;
  weather: WeatherNow | null;
  placeName?: string;
}) {
  const { t } = useTranslation();
  const condition = weather?.condition ?? "clear";
  const grey = ["overcast", "fog", "drizzle", "rain", "snow", "thunder"].includes(condition);
  const sun = !grey && (part === "day" || part === "dawn" || part === "dusk");
  const night = part === "night";
  const falling = condition === "rain" || condition === "drizzle" || condition === "thunder" ? "rain" : condition === "snow" ? "snow" : null;
  const caption = weather
    ? t("desk.window.weather", {
        place: placeName ?? "",
        condition: t(`desk.window.conditions.${condition}`),
        temperature: Math.round(weather.temperature_c),
      })
    : null;
  return (
    <figure className="ca-desk-window-wrap">
      <span className="ca-desk-window" data-part={part} data-weather={condition} role="img" aria-label={caption ?? t(`desk.window.${part}`)}>
        <svg viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <filter id="ca-fog-blur" x="-10%" y="-50%" width="120%" height="200%">
              <feGaussianBlur stdDeviation="4" />
            </filter>
            <linearGradient id="ca-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={`var(--sky-${part}-top)`} />
              <stop offset="1" stopColor={`var(--sky-${part}-bottom)`} />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="200" height="140" fill="url(#ca-sky)" />
          {sun && <circle cx={part === "dusk" ? 150 : 56} cy={part === "day" ? 34 : 70} r="13" fill="var(--sun)" opacity="0.9" />}
          {night && !grey && (
            <>
              {/* 真实月相：暗的部分隐约可见（地照），亮的部分按盈亏画。 */}
              <circle cx="150" cy="40" r="12" fill="var(--moon)" opacity="0.06" />
              <path d={moonLitPath(moon, 150, 40, 12)} fill="var(--moon)" opacity="0.92" />
              {[[40, 24], [70, 46], [104, 18], [124, 52], [178, 70], [28, 62]].map(([x, y]) => (
                <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="var(--moon)" opacity="0.8" />
              ))}
            </>
          )}
          {/* 阴天一层灰：天色还在，只是蒙上了。 */}
          {grey && <rect x="0" y="0" width="200" height="140" fill="var(--overcast)" opacity={night ? 0.35 : 0.55} />}
          {(condition === "cloudy" || (part === "day" && condition === "clear")) && (
            <g fill="var(--cloud)" opacity="0.9" data-clouds="">
              <ellipse cx="128" cy="40" rx="20" ry="7" />
              <ellipse cx="142" cy="35" rx="12" ry="7" />
              {condition === "cloudy" && (
                <>
                  <ellipse cx="70" cy="30" rx="24" ry="8" />
                  <ellipse cx="86" cy="25" rx="14" ry="8" />
                </>
              )}
              <ellipse cx="86" cy="62" rx="14" ry="5" />
            </g>
          )}
          {grey && condition !== "fog" && (
            <g fill="var(--cloud-dark)" opacity={night ? 0.5 : 0.8}>
              <ellipse cx="40" cy="14" rx="46" ry="16" />
              <ellipse cx="110" cy="10" rx="50" ry="18" />
              <ellipse cx="180" cy="16" rx="40" ry="15" />
            </g>
          )}
          <path
            d="M0 112c26-14 48-18 74-10s44 4 66-8 40-8 60 2v44H0z"
            fill={night ? `color-mix(in srgb, var(--hill-${season}) 35%, var(--sky-night-bottom))` : `var(--hill-${season})`}
            opacity={condition === "fog" ? 0.35 : 1}
          />
          {condition === "fog" && (
            <g fill="var(--cloud)" opacity="0.7" filter="url(#ca-fog-blur)">
              <rect x="-10" y="58" width="220" height="10" rx="5" />
              <rect x="-10" y="80" width="220" height="12" rx="6" />
              <rect x="-10" y="104" width="220" height="14" rx="7" />
            </g>
          )}
          {condition === "snow" && <rect x="0" y="122" width="200" height="18" fill="var(--snow)" opacity="0.85" />}
          {falling && (
            <g className={`ca-window-fall ${falling}`}>
              {[0, -140].map((offset) => (
                <g key={offset} transform={`translate(0 ${offset})`}>
                  {DROPS.slice(0, condition === "drizzle" ? 14 : DROPS.length).map(({ x, y }) =>
                    falling === "rain" ? (
                      <line key={`${x}-${y}`} x1={x} y1={y} x2={x - 3} y2={y + 9} stroke="var(--rain)" strokeWidth="1" />
                    ) : (
                      <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="var(--snow)" />
                    ),
                  )}
                </g>
              ))}
            </g>
          )}
          {condition === "thunder" && <rect className="ca-window-flash" x="0" y="0" width="200" height="140" fill="var(--snow)" />}
        </svg>
        <span className="ca-desk-window-bars" aria-hidden="true" />
      </span>
      {caption && <figcaption className="ca-desk-label">{caption}</figcaption>}
    </figure>
  );
}

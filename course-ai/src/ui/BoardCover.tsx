import type { ReactNode } from "react";
import { courseTone, stableIndex, type CoverKind, type CoverShape } from "@/lib/coverKind";
import type { CourseColor } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 黑板封面：课程、牌堆这类「一叠视频」用它；单个视频有首帧时用首帧（见 LectureCover）。
 * 黑板底 + 很淡的粉笔学科图 + 左上课程名 + 左下衬线大数字（课程颜色）。
 * 尺寸随容器缩放（容器查询），从列表行里的小缩略图到主页大卡都是同一张图。
 */

/** 每种学科的粉笔图。viewBox 300×169，主要画在右侧 60%，左下留给数字。 */
const ART: Record<Exclude<CoverKind, "generic" | "custom">, ReactNode> = {
  linear: (
    <>
      <text x="150" y="62" fontSize="24">A = SΛS⁻¹</text>
      <text x="168" y="96" fontSize="15">Ax = λx</text>
      <path className="stroke" d="M262 118v38M262 156h-38M262 156l-22-16M262 156l14-30" />
    </>
  ),
  calculus: (
    <>
      <text x="160" y="58" fontSize="26">∫ f(x) dx</text>
      <path className="stroke" d="M150 150h138M156 156V86" />
      <path className="stroke" d="M160 146c30-4 40-50 64-50s34 38 60 42" />
    </>
  ),
  probability: (
    <>
      <path className="stroke" d="M150 148h140" />
      <path className="stroke" d="M154 146c30 0 40-92 66-92s36 92 66 92" />
      <path className="stroke" d="M220 54v94" strokeDasharray="3 4" />
      <text x="160" y="40" fontSize="18">P(A|B)</text>
    </>
  ),
  ml: (
    <>
      <g className="stroke">
        <circle cx="180" cy="50" r="7" />
        <circle cx="180" cy="90" r="7" />
        <circle cx="180" cy="130" r="7" />
        <circle cx="235" cy="70" r="7" />
        <circle cx="235" cy="110" r="7" />
        <circle cx="282" cy="90" r="7" />
        <path d="M187 50l41 19M187 52l41 55M187 90l41-19M187 90l41 19M187 128l41-53M187 130l41-19M242 70l33 18M242 110l33-18" />
      </g>
      <text x="150" y="160" fontSize="13">∇L(θ)</text>
    </>
  ),
  network: (
    <g className="stroke">
      <circle cx="190" cy="50" r="9" />
      <circle cx="250" cy="40" r="9" />
      <circle cx="270" cy="100" r="9" />
      <circle cx="210" cy="118" r="9" />
      <circle cx="160" cy="98" r="9" />
      <path d="M198 48l43-6M257 47l9 44M261 103l-42 13M201 114l-33-12M163 89l22-31M197 57l7 52" />
    </g>
  ),
  systems: (
    <>
      <g className="stroke">
        <rect x="160" y="34" width="120" height="22" rx="3" />
        <rect x="160" y="64" width="56" height="22" rx="3" />
        <rect x="224" y="64" width="56" height="22" rx="3" />
        <rect x="160" y="94" width="120" height="22" rx="3" />
      </g>
      <text x="160" y="146" fontSize="12" className="mono">fork() · mmap()</text>
    </>
  ),
  datastruct: (
    <>
      <g className="stroke">
        <circle cx="226" cy="36" r="10" />
        <circle cx="190" cy="80" r="10" />
        <circle cx="262" cy="80" r="10" />
        <circle cx="170" cy="124" r="10" />
        <circle cx="208" cy="124" r="10" />
        <circle cx="282" cy="124" r="10" />
        <path d="M219 44l-22 28M233 44l22 28M185 89l-10 26M195 89l8 26M267 89l10 26" />
      </g>
      <text x="150" y="160" fontSize="12" className="mono">O(log n)</text>
    </>
  ),
  economics: (
    <>
      <path className="stroke" d="M160 150h130M164 156V30" />
      <path className="stroke" d="M176 46c30 40 70 80 106 96M176 140c40-20 74-60 104-96" />
      <text x="276" y="42" fontSize="13">S</text>
      <text x="278" y="136" fontSize="13">D</text>
      <path className="stroke" d="M227 93h-63M227 93v57" strokeDasharray="3 4" />
    </>
  ),
  language: (
    <>
      <text x="158" y="66" fontSize="40" className="upright">あいう</text>
      <text x="166" y="102" fontSize="16" className="upright">～ようにする</text>
    </>
  ),
  psychology: (
    <path className="stroke" d="M224 26l58 118H166zM195 85h58M180 115h88M209 56h30" />
  ),
  philosophy: (
    <>
      <text x="170" y="96" fontSize="96" className="upright">“</text>
      <text x="160" y="112" fontSize="17">γνῶθι σεαυτόν</text>
    </>
  ),
  physics: (
    <>
      <text x="160" y="56" fontSize="24">F = ma</text>
      <path className="stroke" d="M152 112c12-28 24-28 36 0s24 28 36 0 24-28 36 0 18 20 26 10" />
      <path className="stroke" d="M160 150h60M212 144l8 6-8 6" />
      <text x="232" y="154" fontSize="13">v</text>
    </>
  ),
  chemistry: (
    <>
      <path className="stroke" d="M226 40l26 15v30l-26 15-26-15V55z" />
      <path className="stroke" d="M226 50l17 10v20l-17 10" opacity="0.6" />
      <path className="stroke" d="M252 55l22-12M200 55l-22-12M226 100v22" />
      <text x="160" y="150" fontSize="16">H₂O · NaCl</text>
    </>
  ),
  biology: (
    <>
      <path className="stroke" d="M186 30c40 16 40 34 0 50s-40 34 0 50M226 30c-40 16-40 34 0 50s40 34 0 50" />
      <path className="stroke" d="M194 38h24M190 55h32M194 72h24M194 88h24M190 105h32M194 122h24" opacity="0.6" />
      <circle className="stroke" cx="268" cy="70" r="20" />
      <circle className="stroke" cx="272" cy="66" r="6" />
    </>
  ),
  programming: (
    <>
      <text x="154" y="70" fontSize="44" className="upright mono">{"{ }"}</text>
      <text x="158" y="104" fontSize="12" className="mono">for x in xs:</text>
      <text x="174" y="122" fontSize="12" className="mono">yield f(x)</text>
      <text x="158" y="146" fontSize="12" className="mono">return 0;</text>
    </>
  ),
  history: (
    <>
      <path className="stroke" d="M152 96h138M168 88v16M206 88v16M244 88v16M280 88v16" />
      <text x="156" y="76" fontSize="12" className="mono">1840</text>
      <text x="196" y="124" fontSize="12" className="mono">1911</text>
      <text x="234" y="76" fontSize="12" className="mono">1949</text>
      <text x="160" y="152" fontSize="14">史料 · 年表</text>
    </>
  ),
};

/**
 * 猜不出学科时的几块「写过的黑板」，按课程名稳定地挑一块，同一屏的课不会长得一模一样。
 * 都画在课程名那条线以下（y > 50）。
 */
const GENERIC_ART: ReactNode[] = [
  // 几行笔记、一个圈出的重点、一个箭头和两行要点。
  <g key="notes" className="stroke" transform="translate(0 14)">
    <path d="M156 40c6-5 10 4 16-1s9 3 15-1 10 3 16-1 9 4 15 0 11 3 17-1 9 2 14 0" />
    <path d="M156 62c6-4 11 3 17-1s9 4 15 0 10-3 16 1 8 2 14-1" />
    <ellipse cx="246" cy="98" rx="30" ry="15" />
    <path d="M234 98c5-4 9 3 13 0s8 2 12-1" />
    <path d="M160 98c18 0 34 0 52 0M204 92l9 6-9 6" />
    <circle cx="162" cy="130" r="2.2" />
    <path d="M172 130c6-4 10 3 16-1s10 3 16-1 9 3 15 0" />
    <path d="M262 136l7 8 14-18" />
  </g>,
  // 思维导图：中间一个词，四条分支。
  <g key="map" className="stroke">
    <ellipse cx="222" cy="106" rx="26" ry="14" />
    <path d="M210 106c4-3 8 2 12 0s8 2 12-1" />
    <path d="M198 98l-30-26M246 98l28-26M198 114l-30 22M246 114l28 22" />
    <path d="M150 68c5-3 9 2 14 0M272 68c5-3 9 2 14 0M150 142c5-3 9 2 14 0M272 142c5-3 9 2 14 0" />
  </g>,
  // 流程：三个框两个箭头，最后打个勾。
  <g key="flow" className="stroke">
    <rect x="154" y="66" width="38" height="24" rx="3" />
    <rect x="206" y="66" width="38" height="24" rx="3" />
    <rect x="258" y="66" width="38" height="24" rx="3" />
    <path d="M192 78h12M200 74l4 4-4 4M244 78h12M252 74l4 4-4 4" />
    <path d="M160 118c6-4 11 3 17-1s9 4 15 0 10-3 16 1 8 2 14-1 10 3 16-1" />
    <path d="M160 140c6-4 10 3 16-1s10 3 16-1" />
    <path d="M262 136l7 8 14-18" />
  </g>,
  // 编号要点：1. 2. 3.，第二条画了下划线。
  <g key="list">
    <text x="156" y="76" fontSize="15" className="mono">1.</text>
    <text x="156" y="108" fontSize="15" className="mono">2.</text>
    <text x="156" y="140" fontSize="15" className="mono">3.</text>
    <g className="stroke">
      <path d="M180 71c6-4 10 3 16-1s9 3 15-1 10 3 16-1 9 4 15 0" />
      <path d="M180 103c6-4 11 3 17-1s9 4 15 0 10-3 16 1 8 2 14-1 10 3 16-1" />
      <path d="M180 114c30 2 60 1 92-1" />
      <path d="M180 135c6-4 10 3 16-1s10 3 16-1" />
      <path d="M274 52l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z" />
    </g>
  </g>,
];

/** AI 为新学科画的图：逐个画成 React 元素（后端已校验过形状和坐标），不插入原始 SVG。 */
function ShapeArt({ shapes }: { shapes: CoverShape[] }) {
  return (
    <>
      {shapes.map((shape, i) => {
        switch (shape.t) {
          case "path":
            return <path key={i} className="stroke" d={shape.d} />;
          case "circle":
            return <circle key={i} className="stroke" cx={shape.cx} cy={shape.cy} r={shape.r} />;
          case "ellipse":
            return <ellipse key={i} className="stroke" cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />;
          case "rect":
            return <rect key={i} className="stroke" x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={2} />;
          case "line":
            return <line key={i} className="stroke" x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} />;
          case "text":
            return (
              <text key={i} x={shape.x} y={shape.y} fontSize={shape.s}>
                {shape.v}
              </text>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** 这门课的关键术语，像板书一样一行一个写在右边，第一个下面划一道。 */
function TermsArt({ terms }: { terms: string[] }) {
  const longest = Math.max(...terms.map((term) => term.length), 1);
  // 右侧大约 140 个单位宽；中文一个字约 1em。
  const size = Math.max(12, Math.min(22, Math.floor(138 / longest)));
  const ys = terms.length === 1 ? [104] : terms.length === 2 ? [86, 124] : [72, 106, 140];
  return (
    <>
      {terms.map((term, i) => (
        <text key={term} x={156} y={ys[i]} fontSize={size} className={/[\u3400-\u9fff]/.test(term) ? "upright" : undefined}>
          {term}
        </text>
      ))}
      <path className="stroke" d={`M156 ${ys[0] + 7}c${size * 1.6} 2 ${size * 3.2} 1 ${Math.min(130, size * longest * 0.9)} -1`} opacity={0.6} />
    </>
  );
}

export function BoardCover({
  kind,
  number,
  unit,
  caption,
  seed,
  art,
  terms,
  color,
  className,
  children,
}: {
  kind: CoverKind;
  /** 封面上的大数字：一讲用讲次号（补成两位），一门课用总讲数（带 unit，不补位）。没有就画学科首字。 */
  number?: number | null;
  /** 数字后的小字（讲）。 */
  unit?: string;
  /** 左上的课程名。小尺寸时自动隐藏。 */
  caption?: string;
  /** 挑通用黑板和默认颜色用的种子（课程名）；不传就用 caption。 */
  seed?: string;
  /** kind = custom 时 AI 画的图。 */
  art?: CoverShape[] | null;
  /** AI 给的关键术语：通用黑板上写的就是它们。 */
  terms?: string[];
  color?: CourseColor | null;
  className?: string;
  /** 叠在封面上的东西（时长、进度条、播放按钮）。 */
  children?: ReactNode;
}) {
  const key = seed ?? caption ?? "";
  // 没选颜色的课按名字稳定地分一个颜色，不然一排课全是白字。
  const tone = courseTone(color, key);
  const numberColor = `var(--course-${tone}-on-dark)`;
  const glyph = number == null ? (caption?.trim().charAt(0) ?? "") : null;
  return (
    <span className={cn("ca-board-cover", className)} data-kind={kind}>
      <svg className="art" viewBox="0 0 300 169" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
        {kind === "custom" && art && art.length > 0 ? (
          <ShapeArt shapes={art} />
        ) : kind === "generic" || kind === "custom" ? (
          terms && terms.length > 0 ? (
            <TermsArt terms={terms} />
          ) : (
            GENERIC_ART[stableIndex(key, GENERIC_ART.length)]
          )
        ) : (
          ART[kind]
        )}
      </svg>
      {caption && (
        <span className="cap" aria-hidden="true">
          {caption}
        </span>
      )}
      <span className="no" style={{ color: numberColor }} aria-hidden="true">
        {glyph ?? (unit ? String(number) : String(number).padStart(2, "0"))}
        {glyph == null && unit ? <small>{unit}</small> : null}
      </span>
      {/* 黑板下沿放粉笔的木槽：一截粉笔、一块板擦。小尺寸时不画。 */}
      <span className="ledge" aria-hidden="true">
        <i />
        <b />
      </span>
      {children}
    </span>
  );
}

import type { ReactNode } from "react";
import type { CoverKind } from "@/lib/coverKind";
import type { CourseColor } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 黑板封面：课程和每一讲统一用它，不用视频缩略图。
 * 黑板底 + 很淡的粉笔学科图 + 左上课程名 + 左下衬线大数字（课程颜色）。
 * 尺寸随容器缩放（容器查询），从列表行里的小缩略图到主页大卡都是同一张图。
 */

/** 每种学科的粉笔图。viewBox 300×169，主要画在右侧 60%，左下留给数字。 */
const ART: Record<Exclude<CoverKind, "generic">, ReactNode> = {
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
};

export function BoardCover({
  kind,
  number,
  unit,
  caption,
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
  color?: CourseColor | null;
  className?: string;
  /** 叠在封面上的东西（时长、进度条、播放按钮）。 */
  children?: ReactNode;
}) {
  const numberColor = color ? `var(--course-${color}-on-dark)` : "var(--chalk)";
  const glyph = number == null ? (caption?.trim().charAt(0) ?? "") : null;
  return (
    <span className={cn("ca-board-cover", className)} data-kind={kind}>
      {kind !== "generic" && (
        <svg className="art" viewBox="0 0 300 169" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
          {ART[kind]}
        </svg>
      )}
      {caption && (
        <span className="cap" aria-hidden="true">
          {caption}
        </span>
      )}
      <span className="no" style={{ color: numberColor }} aria-hidden="true">
        {glyph ?? (unit ? String(number) : String(number).padStart(2, "0"))}
        {glyph == null && unit ? <small>{unit}</small> : null}
      </span>
      {children}
    </span>
  );
}

import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MATH_RE } from "@/lib/markdownToTiptap";
import {
  CAPTION_SIZE_SCALE,
  useCaptionPrefs,
  type CaptionMode,
} from "@/stores/captionPrefs";
import { captionRequiredHeight, fitCaptionFontSize } from "./captionFit";

// KaTeX 较重，仅在字幕真含公式时按需加载，避免拖累播放器首屏。
const MathText = lazy(() =>
  import("@/ui/MathText").then((m) => ({ default: m.MathText })),
);

function hasMath(text: string): boolean {
  return new RegExp(MATH_RE.source).test(text);
}

/** 渲染字幕文本：含 LaTeX 公式时用 KaTeX，否则纯文本。加载前先去掉定界符兜底。 */
function CaptionText({ text }: { text: string }) {
  if (!hasMath(text)) return <>{text}</>;
  return (
    <Suspense fallback={<>{text.replace(/\\[()[\]]/g, "")}</>}>
      <MathText text={text} />
    </Suspense>
  );
}

/** 字幕框：位置和大小都用相对画面的比例（0~1）存，这样全屏/缩放都自适应。 */
type Box = { left: number; top: number; width: number; height: number };
type Corner = "nw" | "ne" | "sw" | "se";

const STORAGE_KEY = "caption-box";
const DEFAULT_BOX: Box = { left: 0.08, top: 0.8, width: 0.84, height: 0.14 };
const MIN = 0.05;
const KEYBOARD_STEP = 0.01;
const KEYBOARD_LARGE_STEP = 0.05;

function clamp(v: number, lo: number, hi: number) {
  if (hi < lo) hi = lo;
  return Math.min(hi, Math.max(lo, v));
}

function loadBox(): Box {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_BOX, ...(JSON.parse(raw) as Partial<Box>) };
  } catch {
    /* ignore */
  }
  return DEFAULT_BOX;
}

const CORNER_CLASS: Record<Corner, string> = {
  nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
  ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
  sw: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
  se: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
};

const CORNER_LABEL_KEY: Record<
  Corner,
  | "videoPlayer.captionCornerNw"
  | "videoPlayer.captionCornerNe"
  | "videoPlayer.captionCornerSw"
  | "videoPlayer.captionCornerSe"
> = {
  nw: "videoPlayer.captionCornerNw",
  ne: "videoPlayer.captionCornerNe",
  sw: "videoPlayer.captionCornerSw",
  se: "videoPlayer.captionCornerSe",
};

// 字幕底边与控制栏顶边之间再留一点呼吸空隙。
const CAPTION_BAR_GAP = 8;

export function CaptionOverlay({
  text,
  translation,
  mode = "original",
  containerRef,
  bottomInset = 0,
}: {
  text: string;
  /** 当前句的译文；没有时双语 / 译文模式都退回只显示原文。 */
  translation?: string;
  mode?: CaptionMode;
  // 定位参照容器：「舞台」区域（含黑边），字幕可在其内任意拖动/缩放。
  containerRef: React.RefObject<HTMLDivElement | null>;
  // 底部控制栏的占位高度（像素）：字幕落入此区时上移，保证永远在控制栏上方。
  // 传实测高度而非「可见时才传」——控制栏是悬浮出没的，字幕位置不应随之跳动。
  bottomInset?: number;
}) {
  const { t } = useTranslation();
  const keyboardHintId = useId();
  const captionTextId = useId();
  const sizeScale = CAPTION_SIZE_SCALE[useCaptionPrefs((s) => s.size)];
  const background = useCaptionPrefs((s) => s.background);
  const [box, setBox] = useState<Box>(loadBox);
  const boxRef = useRef(box);
  boxRef.current = box;
  const [stageHeight, setStageHeight] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);
  // 拖动/缩放期间置真：此时字幕跟手直改 top/left，不抬升、也不过渡，避免抽搐。
  const [dragging, setDragging] = useState(false);

  // 必须用 passive effect 量高：containerRef 指向「祖先」节点，React 提交顺序里
  // 子组件的 layout effect 先于祖先 host ref 附上——layout 阶段读 ref 永远是 null，
  // 且 deps 不变不会重跑，stageHeight 会永远卡在 0（字号恒为最小、避让失效）。
  // passive effect 在 ref 全部附上后运行；组件随播放器常驻挂载、首帧字幕文本为空，
  // 不存在「先小后大」的首帧跳变。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setStageHeight(el.clientHeight);
      setStageWidth(el.clientWidth);
    };
    update();
    // jsdom / 极旧 WebView 无 ResizeObserver：至少量一次，尺寸变化不再跟踪。
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(box));
    } catch {
      /* ignore */
    }
  }, [box]);

  function withDrag(handler: (ev: PointerEvent, rect: DOMRect) => void) {
    return (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDragging(true);
      const move = (ev: PointerEvent) => handler(ev, rect);
      const up = () => {
        setDragging(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
  }

  const startMove = (() => {
    let start = boxRef.current;
    let startX = 0;
    let startY = 0;
    return (event: React.PointerEvent) => {
      start = boxRef.current;
      startX = event.clientX;
      startY = event.clientY;
      withDrag((ev, rect) => {
        const left = clamp(
          start.left + (ev.clientX - startX) / rect.width,
          0,
          1 - start.width,
        );
        const top = clamp(
          start.top + (ev.clientY - startY) / rect.height,
          0,
          1 - start.height,
        );
        setBox({ ...start, left, top });
      })(event);
    };
  })();

  function startResize(corner: Corner) {
    return (event: React.PointerEvent) => {
      const start = boxRef.current;
      const right = start.left + start.width;
      const bottom = start.top + start.height;
      withDrag((ev, rect) => {
        const px = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const py = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
        let { left, top, width, height } = start;
        if (corner === "se" || corner === "ne") width = px - left;
        if (corner === "sw" || corner === "nw") {
          left = px;
          width = right - px;
        }
        if (corner === "se" || corner === "sw") height = py - top;
        if (corner === "ne" || corner === "nw") {
          top = py;
          height = bottom - py;
        }
        if (width < MIN) {
          width = MIN;
          left = Math.min(left, right - MIN);
        }
        if (height < MIN) {
          height = MIN;
          top = Math.min(top, bottom - MIN);
        }
        setBox({
          left: clamp(left, 0, 1 - width),
          top: clamp(top, 0, 1 - height),
          width,
          height,
        });
      })(event);
    };
  }

  function consumeKeyboardAdjustment(event: React.KeyboardEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
  }

  function handleMoveKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Home") {
      consumeKeyboardAdjustment(event);
      setBox({ ...DEFAULT_BOX });
      return;
    }

    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;

    consumeKeyboardAdjustment(event);
    setBox((current) => ({
      ...current,
      left: clamp(current.left + dx, 0, 1 - current.width),
      top: clamp(current.top + dy, 0, 1 - current.height),
    }));
  }

  function handleResizeKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    corner: Corner,
  ) {
    if (event.key === "Home") {
      consumeKeyboardAdjustment(event);
      setBox({ ...DEFAULT_BOX });
      return;
    }

    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;

    consumeKeyboardAdjustment(event);
    setBox((current) => {
      let left = current.left;
      let right = current.left + current.width;
      let top = current.top;
      let bottom = current.top + current.height;

      if (corner === "nw" || corner === "sw") {
        left = clamp(left + dx, 0, right - MIN);
      } else {
        right = clamp(right + dx, left + MIN, 1);
      }
      if (corner === "nw" || corner === "ne") {
        top = clamp(top + dy, 0, bottom - MIN);
      } else {
        bottom = clamp(bottom + dy, top + MIN, 1);
      }

      return { left, top, width: right - left, height: bottom - top };
    });
  }

  const showTranslation = mode !== "original" && !!translation?.trim();
  const primary = showTranslation && mode === "translation" ? translation! : text;
  // 字幕框负责可视区域；字号只在这个区域里受限自适应：按框高给两行（双语再加一行译文）
  // 留余量，再按框宽估算折行——窄屏上长译文折成两行时继续收小，不让框把字裁掉。
  const bilingualTranslation = showTranslation && mode === "bilingual" ? translation : undefined;
  // 用户选的字号档位乘在自适应字号上；调大后放不下的部分交给下面的「向上长高」。
  const fontSize =
    fitCaptionFontSize({
      boxWidthPx: stageWidth * box.width,
      boxHeightPx: stageHeight * box.height,
      primary,
      translation: bilingualTranslation,
    }) * sizeScale;
  // 字号到下限仍放不下（手机竖屏的矮舞台 + 双语、或调成了大字号）：框底边不动，
  // 向上长高到够用，最多长到舞台顶边——宁可多遮一点画面，也不把字幕裁成半行。
  const growPx = clamp(
    captionRequiredHeight({
      fontSize,
      boxWidthPx: stageWidth * box.width,
      primary,
      translation: bilingualTranslation,
    }) -
      stageHeight * box.height,
    0,
    box.top * stageHeight,
  );

  // 字幕上移量：字幕底边探入控制栏占位区（bottomInset）时抬起，
  // 且不超过其顶边余量（避免顶出画面）。拖动/缩放期间不抬升——字幕直接跟手，松手后再归位。
  const captionBottomPx = (box.top + box.height) * stageHeight;
  const safeBottomPx = stageHeight - bottomInset - CAPTION_BAR_GAP;
  const lift =
    !dragging && bottomInset > 0
      ? clamp(captionBottomPx - safeBottomPx, 0, box.top * stageHeight)
      : 0;

  // 段间空文本：组件保持挂载（stageHeight 不丢），仅不显示字幕框。
  if (!primary.trim()) return null;

  return (
    <div
      className="group absolute touch-none select-none transition-transform duration-200"
      style={{
        left: `${box.left * 100}%`,
        top: growPx > 0 ? `calc(${box.top * 100}% - ${growPx}px)` : `${box.top * 100}%`,
        width: `${box.width * 100}%`,
        height: growPx > 0 ? `calc(${box.height * 100}% + ${growPx}px)` : `${box.height * 100}%`,
        transform: lift > 0 ? `translateY(${-lift}px)` : undefined,
        // 拖动时关掉 transform 过渡，避免位置追着 200ms 缓动走而抖动。
        transition: dragging ? "none" : undefined,
      }}
    >
      <span id={keyboardHintId} className="sr-only">
        {t("videoPlayer.captionKeyboardHint")}
      </span>
      <button
        type="button"
        aria-label={t("videoPlayer.captionMoveLabel", {
          left: Math.round(box.left * 100),
          top: Math.round(box.top * 100),
        })}
        aria-describedby={`${captionTextId} ${keyboardHintId}`}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Home"
        onPointerDown={startMove}
        onKeyDown={handleMoveKeyDown}
        // 字幕贴着框底排、多出来的行往上长（YouTube / B 站都是这样）：换句时底行不跳。
        // 底色逐行包住文字（见 .ca-caption-line），框本身透明，只在悬停时描一圈提示可拖。
        className="flex h-full w-full cursor-move items-end justify-center overflow-hidden rounded-md border-0 bg-transparent px-3 pb-[0.2em] text-center font-medium leading-snug text-white ring-1 ring-transparent transition-[box-shadow] group-hover:ring-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
        style={{ fontSize }}
      >
        <span id={captionTextId} className="flex flex-col items-center gap-[0.12em]">
          <span>
            <span className="ca-caption-line" data-bg={background}>
              <CaptionText text={primary} />
            </span>
          </span>
          {showTranslation && mode === "bilingual" && (
            // 双语：原文在上，译文在下、略小略淡。
            <span className="text-[0.82em]">
              <span
                data-caption-translation=""
                data-bg={background}
                className="ca-caption-line text-white/90"
              >
                {translation}
              </span>
            </span>
          )}
        </span>
      </button>
      {(Object.keys(CORNER_CLASS) as Corner[]).map((corner) => (
        <button
          key={corner}
          type="button"
          aria-label={t("videoPlayer.captionResizeLabel", {
            corner: t(CORNER_LABEL_KEY[corner]),
            width: Math.round(box.width * 100),
            height: Math.round(box.height * 100),
          })}
          aria-describedby={keyboardHintId}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Home"
          onPointerDown={startResize(corner)}
          onKeyDown={(event) => handleResizeKeyDown(event, corner)}
          className={`absolute h-3.5 w-3.5 rounded-full border border-white/80 bg-[var(--video-accent)] p-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${CORNER_CLASS[corner]}`}
        />
      ))}
    </div>
  );
}

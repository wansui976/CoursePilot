import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { MATH_RE } from "@/lib/markdownToTiptap";

// KaTeX 较重，仅在字幕真含公式时按需加载，避免拖累播放器首屏。
const MathText = lazy(() =>
  import("@/components/MathText").then((m) => ({ default: m.MathText })),
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
const CAPTION_SAFE_LINES = 2;
const CAPTION_LINE_HEIGHT = 1.375; // Tailwind `leading-snug`
const CAPTION_SAFE_HEIGHT_RATIO = 0.9;

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

// 字幕底边与控制栏顶边之间再留一点呼吸空隙。
const CAPTION_BAR_GAP = 8;

export function CaptionOverlay({
  text,
  containerRef,
  bottomInset = 0,
}: {
  text: string;
  // 定位参照容器：「舞台」区域（含黑边），字幕可在其内任意拖动/缩放。
  containerRef: React.RefObject<HTMLDivElement | null>;
  // 底部控制栏遮住舞台底部的像素数：字幕落入此区时上移，浮在控制栏之上。
  bottomInset?: number;
}) {
  const [box, setBox] = useState<Box>(loadBox);
  const boxRef = useRef(box);
  boxRef.current = box;
  const [stageHeight, setStageHeight] = useState(0);
  // 拖动/缩放期间置真：此时字幕跟手直改 top/left，不抬升、也不过渡，避免抽搐。
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setStageHeight(el.clientHeight);
    update();
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

  // 字幕框负责可视区域；字号只在这个区域里受限自适应，给两行字幕留出安全余量，避免高框时把字顶到边上。
  const fontSize = clamp(
    (stageHeight * box.height * CAPTION_SAFE_HEIGHT_RATIO) /
      (CAPTION_SAFE_LINES * CAPTION_LINE_HEIGHT),
    12,
    120,
  );

  // 字幕上移量：仅当控制栏可见（bottomInset>0）且字幕底边探入其遮挡区时才抬起，
  // 且不超过其顶边余量（避免顶出画面）。拖动/缩放期间不抬升——字幕直接跟手，松手后再归位。
  const captionBottomPx = (box.top + box.height) * stageHeight;
  const safeBottomPx = stageHeight - bottomInset - CAPTION_BAR_GAP;
  const lift =
    !dragging && bottomInset > 0
      ? clamp(captionBottomPx - safeBottomPx, 0, box.top * stageHeight)
      : 0;

  return (
    <div
      className="group absolute touch-none select-none transition-transform duration-200"
      style={{
        left: `${box.left * 100}%`,
        top: `${box.top * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`,
        transform: lift > 0 ? `translateY(${-lift}px)` : undefined,
        // 拖动时关掉 transform 过渡，避免位置追着 200ms 缓动走而抖动。
        transition: dragging ? "none" : undefined,
      }}
    >
      <div
        onPointerDown={startMove}
        className="flex h-full w-full cursor-move items-center justify-center overflow-hidden rounded bg-black/70 px-3 text-center leading-snug text-white shadow-lg ring-1 ring-transparent [text-shadow:0_1px_2px_rgba(0,0,0,0.9)] group-hover:ring-white/30"
        style={{ fontSize }}
      >
        <CaptionText text={text} />
      </div>
      {(Object.keys(CORNER_CLASS) as Corner[]).map((corner) => (
        <span
          key={corner}
          onPointerDown={startResize(corner)}
          className={`absolute h-3.5 w-3.5 rounded-full border border-white/80 bg-primary opacity-0 transition-opacity group-hover:opacity-100 ${CORNER_CLASS[corner]}`}
        />
      ))}
    </div>
  );
}

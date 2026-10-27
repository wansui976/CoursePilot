import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useTours, type TourId } from "@/stores/tours";

/**
 * 新手引导气泡：指向页面上带 data-tour="<anchor>" 的元素，一步一步介绍。
 *
 * - 页面只负责在合适的地方挂上 <Tour>（以及决定 enabled）；锚点用 data-tour 标在按钮上，
 *   同名锚点可以有多个（侧栏展开 / 收起两套按钮），取当前看得见的那个。
 * - 锚点不在（窄屏布局、功能没开）的步骤直接跳过，「第几步 / 共几步」只数开场时在的那些。
 * - 每组只出现一次：看完、点关闭或按 Esc 都记为看过；引导中途离开页面也算看过，
 *   免得下次从头再来一遍。
 */
export type TourStep = {
  anchor: string;
  title: string;
  body: string;
  /** 优先放在锚点的哪一边；放不下时自动换边。默认下方。 */
  placement?: Placement;
};
type Placement = "top" | "bottom" | "left" | "right";

const GAP = 12; // 气泡与锚点的距离（含箭头）
const MARGIN = 12; // 气泡离视口边缘的最小距离
const ARROW = 8;
const POLL_MS = 250;

function visibleRect(el: Element): DOMRect | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
    return null;
  }
  return rect;
}

/**
 * 当前看得见的锚点。同名的有好几个时取面积最大的：空课程库里侧栏有个小「+」、
 * 正中还有个「添加课程文件夹」大按钮，指向大的那个更好找。
 */
export function findAnchor(anchor: string): { el: Element; rect: DOMRect } | null {
  let best: { el: Element; rect: DOMRect } | null = null;
  for (const el of document.querySelectorAll(`[data-tour="${anchor}"]`)) {
    const rect = visibleRect(el);
    if (rect && (!best || rect.width * rect.height > best.rect.width * best.rect.height)) {
      best = { el, rect };
    }
  }
  return best;
}

/**
 * 页面上已经开着别的对话框时先不打扰。只算看得见的：手机上助手面板收起时仍挂在
 * DOM 里（display: none），不能把它当成开着。
 */
function otherDialogOpen() {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
    (el) => !el.closest("[data-tour-bubble]") && visibleRect(el) !== null,
  );
}

type Position = { left: number; top: number; placement: Placement; arrow: number };

function place(anchor: DOMRect, size: { w: number; h: number }, preferred: Placement): Position {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits: Record<Placement, boolean> = {
    bottom: vh - anchor.bottom >= size.h + GAP + MARGIN,
    top: anchor.top >= size.h + GAP + MARGIN,
    right: vw - anchor.right >= size.w + GAP + MARGIN,
    left: anchor.left >= size.w + GAP + MARGIN,
  };
  const opposite: Record<Placement, Placement> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const order: Placement[] = [preferred, opposite[preferred], "bottom", "top", "right", "left"];
  const placement = order.find((p) => fits[p]) ?? "bottom";
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (placement === "top" || placement === "bottom") {
    const center = anchor.left + anchor.width / 2;
    const left = clamp(center - size.w / 2, MARGIN, vw - size.w - MARGIN);
    const top = placement === "bottom" ? anchor.bottom + GAP : anchor.top - GAP - size.h;
    return { left, top: clamp(top, MARGIN, vh - size.h - MARGIN), placement, arrow: clamp(center - left, 18, size.w - 18) };
  }
  const middle = anchor.top + anchor.height / 2;
  const top = clamp(middle - size.h / 2, MARGIN, vh - size.h - MARGIN);
  const left = placement === "right" ? anchor.right + GAP : anchor.left - GAP - size.w;
  return { left, top, placement, arrow: clamp(middle - top, 18, size.h - 18) };
}

export function Tour({
  id,
  steps,
  enabled = true,
  delay = 700,
}: {
  id: TourId;
  steps: TourStep[];
  enabled?: boolean;
  /** 页面出现后等多久再露面（等布局和数据稳定）。 */
  delay?: number;
}) {
  const { t } = useTranslation();
  const seen = useTours((s) => s.seen.has(id));
  const claim = useTours((s) => s.claim);
  const finish = useTours((s) => s.finish);
  const release = useTours((s) => s.release);
  // 开场时在的那些步骤（下标），以及当前走到第几个
  const [available, setAvailable] = useState<number[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const open = available !== null;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  // 等待阶段：锚点出现、没有别的对话框，并且抢到了位置，才开场。
  useEffect(() => {
    if (!enabled || seen || open) return;
    let cancelled = false;
    let timer = window.setTimeout(function poll() {
      if (cancelled) return;
      const present = stepsRef.current
        .map((step, index) => (findAnchor(step.anchor) ? index : -1))
        .filter((index) => index >= 0);
      if (present.length > 0 && !otherDialogOpen() && claim(id)) {
        setAvailable(present);
        setCursor(0);
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, seen, open, claim, id, delay]);

  const done = useCallback(() => {
    setAvailable(null);
    setAnchorRect(null);
    setPos(null);
    finish(id);
  }, [finish, id]);

  // 引导中途离开页面（组件卸载）：算看过。
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(
    () => () => {
      if (openRef.current) finish(id);
      else release(id);
    },
    [finish, release, id],
  );

  // 进行中：跟着锚点走（滚动、窗口缩放、面板拖宽都会移动它）；锚点没了就跳到下一步。
  const stepIndex = available ? available[cursor] : -1;
  useEffect(() => {
    if (!available || stepIndex < 0) return;
    let frame = 0;
    let missingSince = 0;
    const track = () => {
      const found = findAnchor(stepsRef.current[stepIndex].anchor);
      if (found) {
        missingSince = 0;
        setAnchorRect((prev) =>
          prev &&
          prev.left === found.rect.left &&
          prev.top === found.rect.top &&
          prev.width === found.rect.width &&
          prev.height === found.rect.height
            ? prev
            : found.rect,
        );
      } else {
        const now = performance.now();
        if (!missingSince) missingSince = now;
        // 锚点消失超过半秒（切了页签、收起了面板）：跳过这一步。
        if (now - missingSince > 500) {
          setAnchorRect(null);
          if (cursor + 1 < available.length) setCursor(cursor + 1);
          else done();
          return;
        }
      }
      frame = window.requestAnimationFrame(track);
    };
    track();
    return () => window.cancelAnimationFrame(frame);
  }, [available, cursor, stepIndex, done]);

  // 量出气泡尺寸再定位置
  useLayoutEffect(() => {
    if (!anchorRect || !bubbleRef.current || stepIndex < 0) return;
    const box = bubbleRef.current.getBoundingClientRect();
    setPos(place(anchorRect, { w: box.width, h: box.height }, stepsRef.current[stepIndex].placement ?? "bottom"));
  }, [anchorRect, stepIndex]);

  // 每到一步，焦点给到主按钮，键盘用户可以直接回车继续。
  useEffect(() => {
    if (pos) primaryRef.current?.focus({ preventScroll: true });
  }, [stepIndex, pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      done();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, done]);

  if (!available || stepIndex < 0 || !anchorRect) return null;
  const step = steps[stepIndex];
  const last = cursor === available.length - 1;
  const titleId = `tour-${id}-title`;

  return createPortal(
    <div className="ca-tour" data-tour-bubble="">
      <div
        className="ca-tour-ring"
        aria-hidden="true"
        style={{
          left: anchorRect.left - 4,
          top: anchorRect.top - 4,
          width: anchorRect.width + 8,
          height: anchorRect.height + 8,
        }}
      />
      <div
        ref={bubbleRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        className="ca-tour-bubble"
        data-placement={pos?.placement ?? "bottom"}
        style={{
          left: pos?.left ?? -9999,
          top: pos?.top ?? -9999,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {pos && (
          <span
            className="ca-tour-arrow"
            aria-hidden="true"
            style={
              pos.placement === "top" || pos.placement === "bottom"
                ? { left: pos.arrow - ARROW }
                : { top: pos.arrow - ARROW }
            }
          />
        )}
        <div className="ca-tour-head">
          <h2 id={titleId} className="ca-tour-title">
            {step.title}
          </h2>
          <button type="button" className="ca-tour-close" aria-label={t("tour.close")} onClick={done}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="ca-tour-body">{step.body}</p>
        <div className="ca-tour-foot">
          {available.length > 1 && (
            <span className="ca-tour-count">
              {t("tour.progress", { current: cursor + 1, total: available.length })}
            </span>
          )}
          <button
            ref={primaryRef}
            type="button"
            className="ca-tour-next"
            onClick={() => (last ? done() : setCursor(cursor + 1))}
          >
            {last ? t("tour.done") : t("tour.next")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

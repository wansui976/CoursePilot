import * as Dialog from "@radix-ui/react-dialog";
import { PencilLine, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";

const MIN_GOAL_MINUTES = 5;
const MAX_GOAL_MINUTES = 180;
const GOAL_STEP_MINUTES = 5;
const PAGE_STEP_MINUTES = 30;
const DIAL_SIZE = 208;
const DIAL_CENTER = DIAL_SIZE / 2;
const DIAL_RADIUS = 78;
const ARC_START_DEGREES = 225;
const ARC_SWEEP_DEGREES = 270;

function clampGoal(value: number, max: number): number {
  const stepped = Math.round(value / GOAL_STEP_MINUTES) * GOAL_STEP_MINUTES;
  return Math.min(max, Math.max(MIN_GOAL_MINUTES, stepped));
}

function pointOnDial(angle: number) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: DIAL_CENTER + DIAL_RADIUS * Math.sin(radians),
    y: DIAL_CENTER - DIAL_RADIUS * Math.cos(radians),
  };
}

function arcPath(startAngle: number, endAngle: number): string {
  const start = pointOnDial(startAngle);
  const end = pointOnDial(endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${DIAL_RADIUS} ${DIAL_RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function goalFromPointer(
  event: PointerEvent<HTMLDivElement>,
  max: number,
  requireRingHit = false,
): number | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const x = event.clientX - (rect.left + rect.width / 2);
  const y = event.clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(x, y);
  if (distance === 0) return null;
  if (requireRingHit) {
    const radius = Math.min(rect.width, rect.height) / 2;
    if (distance < radius * 0.5 || distance > radius * 1.05) return null;
  }

  const pointerAngle = ((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360;
  const relativeAngle = (pointerAngle - ARC_START_DEGREES + 360) % 360;
  let arcAngle = relativeAngle;

  if (relativeAngle > ARC_SWEEP_DEGREES) {
    const distanceToEnd = relativeAngle - ARC_SWEEP_DEGREES;
    const distanceToStart = 360 - relativeAngle;
    arcAngle = distanceToStart < distanceToEnd ? 0 : ARC_SWEEP_DEGREES;
  }

  const stepCount = (max - MIN_GOAL_MINUTES) / GOAL_STEP_MINUTES;
  const stepIndex = Math.round((arcAngle / ARC_SWEEP_DEGREES) * stepCount);
  return MIN_GOAL_MINUTES + stepIndex * GOAL_STEP_MINUTES;
}

export function DailyGoalDialog({
  value,
  onSave,
}: {
  value: number;
  onSave: (minutes: number) => void;
}) {
  const maxGoalMinutes = Math.max(
    MAX_GOAL_MINUTES,
    Math.ceil(value / GOAL_STEP_MINUTES) * GOAL_STEP_MINUTES,
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => clampGoal(value, maxGoalMinutes));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const dialRef = useRef<HTMLDivElement>(null);
  const portalContainer = triggerRef.current?.closest(".ca-app") as HTMLElement | null;

  const ratio =
    (draft - MIN_GOAL_MINUTES) / (maxGoalMinutes - MIN_GOAL_MINUTES);
  const thumb = pointOnDial(
    ARC_START_DEGREES + ARC_SWEEP_DEGREES * ratio,
  );

  function changeDraft(next: number) {
    setDraft(clampGoal(next, maxGoalMinutes));
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) setDraft(clampGoal(value, maxGoalMinutes));
    draggingPointer.current = null;
    setOpen(nextOpen);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const next = goalFromPointer(event, maxGoalMinutes, true);
    if (next == null) return;
    event.preventDefault();
    draggingPointer.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in older webviews; movement still works over the dial.
    }
    setDraft(next);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (draggingPointer.current !== event.pointerId) return;
    const next = goalFromPointer(event, maxGoalMinutes);
    if (next != null) setDraft(next);
  }

  function finishPointer(event: PointerEvent<HTMLDivElement>) {
    if (draggingPointer.current !== event.pointerId) return;
    draggingPointer.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the webview.
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = draft + GOAL_STEP_MINUTES;
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = draft - GOAL_STEP_MINUTES;
        break;
      case "PageUp":
        next = draft + PAGE_STEP_MINUTES;
        break;
      case "PageDown":
        next = draft - PAGE_STEP_MINUTES;
        break;
      case "Home":
        next = MIN_GOAL_MINUTES;
        break;
      case "End":
        next = maxGoalMinutes;
        break;
      default:
        return;
    }
    event.preventDefault();
    changeDraft(next);
  }

  function save() {
    onSave(draft);
    setOpen(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label="编辑目标"
          title="编辑目标"
          className="ca-touch-44 grid h-7 w-7 flex-none cursor-pointer place-items-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <PencilLine className="h-3.5 w-3.5" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal container={portalContainer ?? undefined}>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            dialRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-[51] w-[calc(100%-2rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-5 text-[var(--text-normal)] shadow-[var(--shadow-pop)]"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold text-[var(--text-strong)]">
              设置每日目标
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                title="关闭"
                className="ca-icon-btn grid flex-none cursor-pointer place-items-center text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div
            ref={dialRef}
            role="slider"
            tabIndex={0}
            aria-label="每日学习目标"
            aria-valuemin={MIN_GOAL_MINUTES}
            aria-valuemax={maxGoalMinutes}
            aria-valuenow={draft}
            aria-valuetext={`${draft} 分钟`}
            onKeyDown={handleKeyDown}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={finishPointer}
            onLostPointerCapture={() => {
              draggingPointer.current = null;
            }}
            className="relative mx-auto h-52 w-52 cursor-grab touch-none select-none !rounded-full outline-none active:cursor-grabbing focus-visible:!outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--surface-panel)]"
            style={{ touchAction: "none" }}
          >
            <svg
              width={DIAL_SIZE}
              height={DIAL_SIZE}
              viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
              aria-hidden="true"
            >
              <path
                d={arcPath(
                  ARC_START_DEGREES,
                  ARC_START_DEGREES + ARC_SWEEP_DEGREES,
                )}
                fill="none"
                stroke="var(--surface-card-active)"
                strokeWidth="14"
                strokeLinecap="round"
              />
              {ratio > 0 && (
                <path
                  d={arcPath(
                    ARC_START_DEGREES,
                    ARC_START_DEGREES + ARC_SWEEP_DEGREES * ratio,
                  )}
                  fill="none"
                  stroke="var(--accent-text)"
                  strokeWidth="14"
                  strokeLinecap="round"
                />
              )}
              <circle
                cx={thumb.x}
                cy={thumb.y}
                r="9"
                fill="var(--surface-panel)"
                stroke="var(--accent-text)"
                strokeWidth="4"
              />
            </svg>

            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-4xl font-semibold tabular-nums text-[var(--text-strong)]">
                {draft}
              </span>
              <span className="mt-1 text-xs text-[var(--text-muted)]">分钟</span>
            </div>
            <span className="pointer-events-none absolute bottom-4 left-5 text-[10px] tabular-nums text-[var(--text-faint)]">
              {MIN_GOAL_MINUTES}
            </span>
            <span className="pointer-events-none absolute bottom-4 right-3 text-[10px] tabular-nums text-[var(--text-faint)]">
              {maxGoalMinutes}
            </span>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" size="sm" variant="outline">
                取消
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              size="sm"
              onClick={save}
              className="border-[var(--accent)] bg-[var(--accent)] !text-white hover:bg-[var(--accent-press)]"
            >
              保存
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

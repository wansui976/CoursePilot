import type { FeynmanResult } from "@/lib/types";

/**
 * 费曼复述结果的展示逻辑：把用户的原话切成「讲对的 / 讲错的 / 普通」几段，
 * 以及「再讲一遍」时这次补上了上次漏掉的哪几点。
 */

export type MarkedPiece = { text: string; kind: "plain" | "covered" | "wrong"; note?: string };

/** 引语对不上原文时，去掉首尾标点再找一次（模型照抄时常多一个句号）。 */
function locate(text: string, quote: string, from: number): number {
  const trimmed = quote.trim();
  if (!trimmed) return -1;
  const exact = text.indexOf(trimmed, from);
  if (exact >= 0) return exact;
  const loose = trimmed.replace(/^[\s，。、！？,.!?「」"“”]+|[\s，。、！？,.!?「」"“”]+$/g, "");
  return loose.length >= 2 ? text.indexOf(loose, from) : -1;
}

export function markExplanation(text: string, result: FeynmanResult): MarkedPiece[] {
  type Span = { start: number; end: number; kind: "covered" | "wrong"; note?: string };
  const spans: Span[] = [];
  const add = (quote: string, kind: Span["kind"], note?: string) => {
    const at = locate(text, quote, 0);
    if (at < 0) return;
    const length = text.indexOf(quote.trim(), at) === at ? quote.trim().length : quote.trim().replace(/^[\s，。、！？,.!?「」"“”]+|[\s，。、！？,.!?「」"“”]+$/g, "").length;
    const span = { start: at, end: at + length, kind, note };
    // 讲错优先：和已有的讲对片段重叠时，讲错的那段盖过去。
    if (spans.some((other) => other.start < span.end && span.start < other.end)) {
      if (kind !== "wrong") return;
      for (let i = spans.length - 1; i >= 0; i -= 1) {
        if (spans[i].start < span.end && span.start < spans[i].end) spans.splice(i, 1);
      }
    }
    spans.push(span);
  };
  result.wrong.forEach((item) => add(item.quote, "wrong", item.correction));
  result.covered.forEach((item) => add(item.quote, "covered"));
  spans.sort((a, b) => a.start - b.start);

  const pieces: MarkedPiece[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) pieces.push({ text: text.slice(cursor, span.start), kind: "plain" });
    pieces.push({ text: text.slice(span.start, span.end), kind: span.kind, ...(span.note ? { note: span.note } : {}) });
    cursor = span.end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), kind: "plain" });
  return pieces;
}

function bigrams(text: string): Set<string> {
  const clean = text.replace(/[\s，。、！？,.!?：:；;（）()]/g, "").toLowerCase();
  const grams = new Set<string>();
  for (let i = 0; i < clean.length - 1; i += 1) grams.add(clean.slice(i, i + 2));
  return grams;
}

/**
 * 两个要点说的是不是一回事：包含关系，或至少 3 个二字组相同且占较短者四成以上。
 * 中文换个说法时重合本就不高，比例不能卡太死；但只共享一个术语（「学习率」）的两点不算同一件事。
 */
export function samePoint(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const gx = bigrams(x);
  const gy = bigrams(y);
  if (gx.size === 0 || gy.size === 0) return false;
  let shared = 0;
  gx.forEach((gram) => {
    if (gy.has(gram)) shared += 1;
  });
  return shared >= 3 && shared / Math.min(gx.size, gy.size) >= 0.4;
}

/** 上次漏掉、这次讲到了的要点。 */
export function filledGaps(previous: FeynmanResult, current: FeynmanResult): string[] {
  return previous.missed
    .map((missed) => missed.point)
    .filter((point) => current.covered.some((covered) => samePoint(point, covered.point)));
}

/** 覆盖率：讲到的要点 / 全部要点（讲到 + 漏掉）。 */
export function coverage(result: FeynmanResult): number {
  const total = result.covered.length + result.missed.length;
  return total === 0 ? 0 : result.covered.length / total;
}

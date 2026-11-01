/**
 * 引导（苏格拉底）模式的结构块。
 *
 * 引导模式下模型在回答末尾附一个 ```socratic {...}``` 块：选项、分级提示、这一步的答案、
 * 进度和收尾总结。界面把它画成按钮，正文里不显示原文。块缺失、没写完（流式中）或
 * JSON 坏了都不能卡住对话：正文照常显示，只是没有那些按钮。
 */

export interface SocraticBlock {
  step?: number;
  total?: number;
  options: string[];
  hints: string[];
  answer?: string;
  done: boolean;
  summary: string[];
}

const FENCE = "```socratic";
const MAX_OPTIONS = 4;
const MAX_HINTS = 3;
const MAX_SUMMARY = 6;
const MAX_ITEM_CHARS = 200;
const MAX_ANSWER_CHARS = 2000;

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, max);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 100 ? value : undefined;
}

export function parseSocraticBlock(raw: string): SocraticBlock | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const done = record.done === true;
  const step = positiveInt(record.step);
  const total = positiveInt(record.total);
  return {
    ...(step ? { step } : {}),
    ...(total && (!step || total >= step) ? { total } : {}),
    options: done ? [] : strings(record.options, MAX_OPTIONS),
    hints: done ? [] : strings(record.hints, MAX_HINTS),
    ...(typeof record.answer === "string" && record.answer.trim()
      ? { answer: record.answer.trim().slice(0, MAX_ANSWER_CHARS) }
      : {}),
    done,
    summary: done ? strings(record.summary, MAX_SUMMARY) : [],
  };
}

/** 把回答拆成「给人看的正文」和结构块。块从最后一个 ```socratic 开始，后面的都不显示。 */
export function splitSocratic(answer: string): { text: string; block: SocraticBlock | null } {
  const start = answer.lastIndexOf(FENCE);
  if (start < 0) return { text: answer, block: null };
  const text = answer.slice(0, start).trimEnd();
  const body = answer.slice(start + FENCE.length);
  const end = body.indexOf("```");
  // 还没写完（流式中）：先藏起来，等闭合了再解析。
  if (end < 0) return { text, block: null };
  return { text, block: parseSocraticBlock(body.slice(0, end).trim()) };
}

/** 给人看的回答正文：引导模式去掉结构块（复制、存笔记、导出对话都用它）。 */
export function visibleAnswer(turn: { answer: string; mode?: "socratic" }): string {
  if (turn.mode !== "socratic") return turn.answer;
  const { text, block } = splitSocratic(turn.answer);
  if (text.trim()) return text;
  // 结构块没闭合 / JSON 坏了：正文被剥空，但整段回答还在——复制空字符串最糟。
  if (!block) return turn.answer;
  // 只有结构、没有正文：把收尾的结论与要点当作可复制的正文。
  const visible = [block.answer ?? "", ...block.summary].filter(Boolean).join("\n");
  if (visible.trim()) return visible;
  // 连结论都还没有（只有选项/提示）：复制这些，别让「复制」得到空字符串。
  const fallback = [...block.options, ...block.hints].filter(Boolean).join("\n");
  return fallback.trim() ? fallback : turn.answer;
}

/**
 * 一段引导是从哪一问开始的：从这一轮往前找，遇到非引导轮或上一段的收尾就停。
 * 收尾时把它当成复习卡的正面。
 */
export function guidedTopic(
  turns: { id: string; question: string; answer: string; mode?: "socratic" }[],
  turnId: string,
): string | null {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) return null;
  let start = index;
  for (let i = index - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.mode !== "socratic" || splitSocratic(turn.answer).block?.done) break;
    start = i;
  }
  return turns[start].question;
}

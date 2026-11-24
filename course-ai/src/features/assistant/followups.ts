/**
 * 回答末尾的追问建议。
 *
 * 普通问答里，模型讲完课程内容后会在末尾附一个 ```followups ["…","…"]``` 块，
 * 给两三个顺着往下问的问题。界面把它画成胶囊按钮挂在最新一轮下面，点了直接发出去；
 * 正文、复制、存笔记里都不出现原文。块缺失、没写完或 JSON 坏了都只是没有按钮。
 */

const FENCE = "```followups";
const MAX_FOLLOWUPS = 3;
const MAX_FOLLOWUP_CHARS = 40;

function parseFollowups(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim();
    // 太长的不像一句追问，像模型把正文塞进来了：宁可不要。
    if (!text || text.length > MAX_FOLLOWUP_CHARS || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
    if (items.length >= MAX_FOLLOWUPS) break;
  }
  return items;
}

/**
 * 拆出正文和追问建议。块从最后一个 ```followups 开始，后面的都不显示。
 * 流式时末尾可能挂着写了一半的围栏（```、```fol），也先藏起来，免得闪一下。
 */
export function splitFollowups(answer: string): { text: string; followups: string[] } {
  const start = answer.lastIndexOf(FENCE);
  if (start < 0) {
    const partial = answer.match(/\n?`{1,3}[a-z]*$/);
    // 前面的 ``` 是奇数个时，这一截是在合上别的代码块，不是追问块的开头。
    const opensBlock =
      partial && (answer.slice(0, partial.index).match(/```/g)?.length ?? 0) % 2 === 0;
    if (partial && opensBlock && FENCE.startsWith(partial[0].trim())) {
      return { text: answer.slice(0, partial.index).trimEnd(), followups: [] };
    }
    return { text: answer, followups: [] };
  }
  const text = answer.slice(0, start).trimEnd();
  const body = answer.slice(start + FENCE.length);
  const end = body.indexOf("```");
  if (end < 0) return { text, followups: [] };
  return { text, followups: parseFollowups(body.slice(0, end).trim()) };
}

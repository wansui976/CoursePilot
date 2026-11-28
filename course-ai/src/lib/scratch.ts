/**
 * 草稿纸（```scratch 块）：助手把多步推导、演算、证明写成一行一步，界面画成方格草稿纸。
 *
 * 写法（系统提示第 10 条）：每行一步；写错又改的那一步整行用 ~~…~~ 包住表示划掉，下一行重写；
 * 最后一行以「答：」（或 Answer:）开头是最终答案，框起来。空行忽略。
 */
export interface ScratchStep {
  text: string;
  /** 划掉的一步：保留划痕，不编号。 */
  struck: boolean;
}

export interface Scratch {
  steps: ScratchStep[];
  answer: string | null;
}

const ANSWER_RE = /^(?:答[:：]|answer\s*[:：])\s*/i;
const STRUCK_RE = /^~~(.+)~~$/;

export function parseScratch(body: string): Scratch {
  const steps: ScratchStep[] = [];
  let answer: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // 模型有时自己编号（「1.」「①」「(1)」），界面统一编号，去掉它的。
    const text = line.replace(/^(?:\d+[.、)]|[①-⑳]|\(\d+\))\s*/, "");
    const answerMatch = text.match(ANSWER_RE);
    if (answerMatch) {
      answer = text.slice(answerMatch[0].length);
      continue;
    }
    const struck = text.match(STRUCK_RE);
    steps.push(struck ? { text: struck[1].trim(), struck: true } : { text, struck: false });
  }
  return { steps, answer };
}

/** 复制、存笔记时把草稿纸还原成普通 markdown：编号列表 + 删除线 + 加粗的答案。 */
export function scratchToMarkdown(answer: string): string {
  return answer.replace(/```scratch[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, body: string) => {
    const scratch = parseScratch(body);
    let n = 0;
    const lines = scratch.steps.map((step) =>
      step.struck ? `   ~~${step.text}~~` : `${++n}. ${step.text}`,
    );
    if (scratch.answer) lines.push("", `**答：${scratch.answer}**`);
    return `${lines.join("\n")}\n`;
  });
}

/** 第 n 步（从 1 起）的圈号；超过 20 步就写数字。 */
export function stepMark(n: number): string {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `${n}.`;
}

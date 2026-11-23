/**
 * 板书封面的学科类型：根据课程名（没有就用视频标题）猜一个，决定封面上画什么粉笔图。
 * 猜不到就是 generic（大号衬线首字）。顺序有讲究：更具体的词放前面（「线性代数」先于「数学」）。
 */
export type CoverKind =
  | "linear"
  | "calculus"
  | "probability"
  | "ml"
  | "network"
  | "systems"
  | "datastruct"
  | "economics"
  | "language"
  | "psychology"
  | "philosophy"
  | "physics"
  | "chemistry"
  | "biology"
  | "programming"
  | "history"
  | "generic";

const RULES: [CoverKind, RegExp][] = [
  ["linear", /线性代数|矩阵|linear\s*algebra|特征值|向量空间/i],
  ["probability", /概率|统计|贝叶斯|probab|statist|随机过程/i],
  ["ml", /机器学习|深度学习|神经网络|强化学习|machine\s*learning|deep\s*learning|neural|transformer|梯度下降/i],
  ["calculus", /微积分|高等数学|高数|数学分析|考研数学|calculus|微分方程|数学/i],
  ["network", /计算机网络|网络|tcp|http|networking|协议/i],
  ["systems", /操作系统|计算机组成|体系结构|编译|operating\s*system|os\b|进程|内存/i],
  ["datastruct", /数据结构|算法|leetcode|algorithm|data\s*structure/i],
  ["programming", /编程|程序设计|python|java(?!script)|javascript|typescript|c\+\+|golang|rust\b|前端|后端|web\s*开发|软件工程|数据库|sql|programming|coding/i],
  ["physics", /物理|力学|电磁|量子|热学|光学|相对论|physics|mechanics|quantum/i],
  ["chemistry", /化学|有机|无机|分子|chemistry|organic/i],
  ["biology", /生物|生理|解剖|遗传|细胞|基因|医学|药理|营养|食品|biology|genetics|anatomy|medic/i],
  ["history", /历史|史纲|近代史|通史|考古|history/i],
  ["economics", /经济|金融|会计|economic|finance|投资/i],
  ["language", /日语|英语|韩语|法语|德语|西班牙语|语法|单词|雅思|托福|n[1-5]\b|jlpt|english|japanese|grammar/i],
  ["psychology", /心理|psycholog|认知/i],
  ["philosophy", /哲学|伦理|philosoph|逻辑学/i],
];

export function guessCoverKind(...texts: (string | null | undefined)[]): CoverKind {
  for (const text of texts) {
    if (!text) continue;
    for (const [kind, re] of RULES) if (re.test(text)) return kind;
  }
  return "generic";
}

/** 由一段文字得到一个稳定的序号：同一门课每次都落在同一个上，不同的课尽量分散。 */
export function stableIndex(text: string | null | undefined, n: number): number {
  let h = 2166136261;
  for (const ch of text ?? "") {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

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
  | "generic";

const RULES: [CoverKind, RegExp][] = [
  ["linear", /线性代数|矩阵|linear\s*algebra|特征值|向量空间/i],
  ["probability", /概率|统计|贝叶斯|probab|statist|随机过程/i],
  ["ml", /机器学习|深度学习|神经网络|强化学习|machine\s*learning|deep\s*learning|neural|transformer|梯度下降/i],
  ["calculus", /微积分|高等数学|高数|数学分析|考研数学|calculus|微分方程|数学/i],
  ["network", /计算机网络|网络|tcp|http|networking|协议/i],
  ["systems", /操作系统|计算机组成|体系结构|编译|operating\s*system|os\b|进程|内存/i],
  ["datastruct", /数据结构|算法|leetcode|algorithm|data\s*structure/i],
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

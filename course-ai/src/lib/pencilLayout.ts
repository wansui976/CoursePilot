/** 页边铅笔批注的排版：在笔记文字里找到原文，算出每条批注放在哪一行旁边。 */

/** 页边两条批注之间至少留这么多空。 */
export const GAP = 8;

/** 在编辑器的文字里找一段原文，返回能画出来的 Range。跨加粗、链接等多个文本节点也找得到。 */
export function findQuoteRange(root: HTMLElement, quote: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  const starts: number[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    starts.push(text.length);
    nodes.push(node as Text);
    text += (node as Text).data;
  }
  const needle = quote.trim();
  const at = needle ? text.indexOf(needle) : -1;
  if (at < 0) return null;
  const end = at + needle.length;
  const locate = (offset: number, preferEnd: boolean) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (starts[i] < offset || (!preferEnd && starts[i] === offset)) {
        return { node: nodes[i], offset: offset - starts[i] };
      }
    }
    return { node: nodes[0], offset: 0 };
  };
  const from = locate(at, false);
  const to = locate(end, true);
  const range = document.createRange();
  range.setStart(from.node, Math.min(from.offset, from.node.length));
  range.setEnd(to.node, Math.min(to.offset, to.node.length));
  return range;
}

/** 把一组想要的纵坐标按高度往下推开，互不重叠。 */
export function stackTops(wanted: number[], heights: number[]): number[] {
  const order = wanted.map((top, i) => ({ top, i })).sort((a, b) => a.top - b.top);
  const out = new Array<number>(wanted.length);
  let floor = -Infinity;
  for (const { top, i } of order) {
    const placed = Math.max(top, floor);
    out[i] = placed;
    floor = placed + (heights[i] ?? 0) + GAP;
  }
  return out;
}


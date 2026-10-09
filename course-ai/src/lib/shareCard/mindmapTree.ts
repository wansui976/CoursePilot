import { Transformer } from "markmap-lib";
import type { TreeInput } from "./layout";

interface MarkmapNode {
  content: string;
  children?: MarkmapNode[];
}

/** markmap 节点内容是 HTML 片段（含实体、行内标签），转成纯文本。 */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 把脑图 Markdown 解析成分享图用的树。没有一级标题时 markmap 的根是空的，
 * 用 `fallbackTitle`（视频标题）补上；整棵树为空时返回 null。
 */
export function markmapToTree(markdown: string, fallbackTitle: string): TreeInput | null {
  const { root } = new Transformer().transform(markdown) as unknown as { root: MarkmapNode };
  const convert = (node: MarkmapNode): TreeInput => ({
    text: htmlToText(node.content),
    children: (node.children ?? []).map(convert).filter((c) => c.text || c.children.length > 0),
  });
  const tree = convert(root);
  if (!tree.text && tree.children.length === 1 && tree.children[0].text) return tree.children[0];
  if (!tree.text) tree.text = fallbackTitle;
  return tree.children.length > 0 ? tree : null;
}

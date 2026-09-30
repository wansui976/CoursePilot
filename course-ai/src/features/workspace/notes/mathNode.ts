import { mergeAttributes, Node } from "@tiptap/core";
import katex from "katex";
// 跟随笔记分包加载，避免 KaTeX 样式进入首屏主包。
import "katex/dist/katex.min.css";

/**
 * 行内数学公式节点（KaTeX 渲染）。作为 atom inline 节点保存 latex 源码，
 * 通过 NodeView 用 KaTeX 渲染成只读公式；display=true 时按行间公式居中显示。
 */
export const MathNode = Node.create({
  name: "math",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: { default: "" },
      display: { default: false },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-math]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // 存档/复制时保留可还原的源码（[katex]...[/katex] 包裹）。
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-math": "true" }),
      `${HTMLAttributes.display ? "$$" : "$"}${HTMLAttributes.latex ?? ""}${
        HTMLAttributes.display ? "$$" : "$"
      }`,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.dataset.math = "true";
      const display = Boolean(node.attrs.display);
      dom.className = display
        ? "katex-block my-1 block text-center"
        : "katex-inline align-middle";
      try {
        katex.render(String(node.attrs.latex ?? ""), dom, {
          displayMode: display,
          throwOnError: false,
          output: "html",
        });
      } catch {
        dom.textContent = String(node.attrs.latex ?? "");
      }
      return { dom };
    };
  },
});

import type { JSONContent } from "@tiptap/core";

// 方括号不转义：`\[ … \]` 是行间公式的定界符，转义了读回来会变成公式。
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_~])/g, "\\$1");
}

function timestampLabel(node: JSONContent): string {
  const label = node.attrs?.label;
  if (typeof label === "string" && label.trim()) return label.trim();
  const totalSeconds = Math.max(0, Math.floor(Number(node.attrs?.ms ?? 0) / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

type Mark = NonNullable<JSONContent["marks"]>[number];

// 由外到内的嵌套顺序；行内代码直接包在文字上，不参与嵌套。
const MARK_ORDER = ["link", "bold", "italic", "strike"];
const DELIMITER: Record<string, string> = { link: "[", bold: "**", italic: "_", strike: "~~" };

function sortedMarks(node: JSONContent): Mark[] {
  return (node.marks ?? [])
    .filter(
      (mark) =>
        MARK_ORDER.includes(mark.type) &&
        (mark.type !== "link" || typeof mark.attrs?.href === "string"),
    )
    .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

function sameMark(a: Mark, b: Mark): boolean {
  return a.type === b.type && (a.type !== "link" || a.attrs?.href === b.attrs?.href);
}

function closeMark(mark: Mark): string {
  return mark.type === "link" ? `](${String(mark.attrs?.href)})` : DELIMITER[mark.type];
}

function textContent(node: JSONContent): string {
  const text = String(node.text ?? "");
  return node.marks?.some((mark) => mark.type === "code")
    ? `\`${text.replace(/`/g, "\\`")}\``
    : escapeText(text);
}

function atomContent(node: JSONContent): string {
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "timestamp") return `[${timestampLabel(node)}]`;
  if (node.type === "math") {
    const latex = String(node.attrs?.latex ?? "");
    return node.attrs?.display ? `$$${latex}$$` : `$${latex}$`;
  }
  if (node.type === "image" && typeof node.attrs?.src === "string") return serializeImage(node);
  return serializeInline(node.content ?? []);
}

/**
 * 行内内容。相邻文字共用的标记只开一次（`**加粗 _斜体_**`，而不是 `**加粗 ****_斜体_**`），
 * 标记两端的空格挪到定界符外面——`** 粗**` 在多数 Markdown 里不算加粗。
 */
function serializeInline(nodes: JSONContent[] = []): string {
  let out = "";
  const stack: Mark[] = [];
  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      const mark = stack.pop()!;
      const trailing = /\s*$/.exec(out)?.[0] ?? "";
      out = out.slice(0, out.length - trailing.length) + closeMark(mark) + trailing;
    }
  };
  for (const node of nodes) {
    if (node.type !== "text") {
      closeTo(0);
      out += atomContent(node);
      continue;
    }
    let text = textContent(node);
    // 纯空白不改变标记：夹在两段加粗之间的空格不该把加粗切成两截。
    const marks = text.trim() === "" ? [...stack] : sortedMarks(node);
    let keep = 0;
    while (keep < stack.length && keep < marks.length && sameMark(stack[keep], marks[keep])) {
      keep += 1;
    }
    closeTo(keep);
    if (marks.length > keep) {
      const leading = /^\s*/.exec(text)?.[0] ?? "";
      out += leading;
      text = text.slice(leading.length);
      for (const mark of marks.slice(keep)) {
        stack.push(mark);
        out += DELIMITER[mark.type];
      }
    }
    out += text;
  }
  closeTo(0);
  return out;
}

function indentContinuation(value: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function serializeImage(node: JSONContent): string {
  return `![${escapeText(String(node.attrs?.alt ?? ""))}](${String(node.attrs?.src ?? "")})`;
}

function serializeList(node: JSONContent): string {
  const ordered = node.type === "orderedList";
  const task = node.type === "taskList";
  const start = Number(node.attrs?.start ?? 1);
  return (node.content ?? [])
    .map((item, index) => {
      const blocks = item.content ?? [];
      const first = blocks[0];
      const firstValue = first?.type === "paragraph"
        ? serializeInline(first.content ?? [])
        : serializeBlock(first);
      const prefix = ordered
        ? `${start + index}. `
        : task
          ? `- [${item.attrs?.checked ? "x" : " "}] `
          : "- ";
      const continuation = blocks
        .slice(1)
        .map((block) => indentContinuation(serializeBlock(block)))
        .join("\n");
      return continuation
        ? `${prefix}${firstValue}\n${continuation}`
        : `${prefix}${firstValue}`;
    })
    .join("\n");
}

function serializeTable(node: JSONContent): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.content?.length ?? 0), 1);
  const rowValues = rows.map((row) =>
    Array.from({ length: width }, (_, index) => {
      const cell = row.content?.[index];
      return serializeBlocks(cell?.content ?? [])
        .replace(/\n\n/g, "<br><br>")
        .replace(/\n/g, "<br>")
        .replace(/\|/g, "\\|");
    }),
  );
  const firstHasHeader = rows[0].content?.some((cell) => cell.type === "tableHeader");
  const header = firstHasHeader ? rowValues[0] : Array.from({ length: width }, () => "");
  const body = firstHasHeader ? rowValues.slice(1) : rowValues;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function serializeBlock(node: JSONContent | undefined): string {
  if (!node) return "";
  if (node.type === "paragraph") return serializeInline(node.content ?? []);
  if (node.type === "heading") {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
    return `${"#".repeat(level)} ${serializeInline(node.content ?? [])}`;
  }
  if (node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList") {
    return serializeList(node);
  }
  if (node.type === "image") return typeof node.attrs?.src === "string" ? serializeImage(node) : "";
  if (node.type === "blockquote") {
    return serializeBlocks(node.content ?? [])
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (node.type === "codeBlock") {
    const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
    const code = (node.content ?? []).map((child) => child.text ?? "").join("");
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }
  if (node.type === "horizontalRule") return "---";
  if (node.type === "table") return serializeTable(node);
  return serializeBlocks(node.content ?? []);
}

function serializeBlocks(nodes: JSONContent[]): string {
  return nodes
    .map(serializeBlock)
    .filter((value) => value !== "")
    .join("\n\n");
}

export function tiptapToMarkdown(doc: JSONContent): string {
  return serializeBlocks(doc.content ?? []).trim();
}

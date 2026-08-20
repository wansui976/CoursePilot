import type { JSONContent } from "@tiptap/core";

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]~])/g, "\\$1");
}

function timestampLabel(node: JSONContent): string {
  const label = node.attrs?.label;
  if (typeof label === "string" && label.trim()) return label.trim();
  const totalSeconds = Math.max(0, Math.floor(Number(node.attrs?.ms ?? 0) / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function serializeText(node: JSONContent): string {
  const marks = node.marks ?? [];
  const code = marks.some((mark) => mark.type === "code");
  let value = code
    ? `\`${String(node.text ?? "").replace(/`/g, "\\`")}\``
    : escapeText(String(node.text ?? ""));

  if (!code) {
    for (const mark of marks) {
      if (mark.type === "bold") value = `**${value}**`;
      if (mark.type === "italic") value = `_${value}_`;
      if (mark.type === "strike") value = `~~${value}~~`;
      if (mark.type === "link" && typeof mark.attrs?.href === "string") {
        value = `[${value}](${mark.attrs.href})`;
      }
    }
  }
  return value;
}

function serializeInline(nodes: JSONContent[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return serializeText(node);
      if (node.type === "hardBreak") return "  \n";
      if (node.type === "timestamp") return `[${timestampLabel(node)}]`;
      if (node.type === "math") {
        const latex = String(node.attrs?.latex ?? "");
        return node.attrs?.display ? `$$${latex}$$` : `$${latex}$`;
      }
      if (node.type === "image" && typeof node.attrs?.src === "string") {
        return `![${escapeText(String(node.attrs?.alt ?? ""))}](${node.attrs.src})`;
      }
      return serializeInline(node.content ?? []);
    })
    .join("");
}

function indentContinuation(value: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function serializeList(node: JSONContent): string {
  const ordered = node.type === "orderedList";
  const start = Number(node.attrs?.start ?? 1);
  return (node.content ?? [])
    .map((item, index) => {
      const blocks = item.content ?? [];
      const first = blocks[0];
      const firstValue = first?.type === "paragraph"
        ? serializeInline(first.content ?? [])
        : serializeBlock(first);
      const prefix = ordered ? `${start + index}. ` : "- ";
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
  if (node.type === "bulletList" || node.type === "orderedList") return serializeList(node);
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

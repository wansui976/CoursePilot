/** 标点和符号：标签上一个都不写。 */
const PUNCT = /[\p{P}\p{S}]/u;

/**
 * 标签上写的字：去掉「一、」「1.」「第三章」「（二）」这类编号；
 * 再在第一个标点处截断（「审题：锁定关键词」→「审题」，「总括词（三类）」→「总括词」），
 * 截出来不到两个字就不截，只把标点去掉。
 */
export function tabLabel(heading: string): string {
  const stripped = heading
    .trim()
    // 多级编号（1.2、2.3.1）整段去掉；「部分」是两个字，单独列出来（字符类里只能一个字一个字地配）。
    .replace(/^第?[一二三四五六七八九十百零〇\d]+(?:[.．][\d]+)*(?:部分|[章节讲课])?\s*[、.．:：)）\s]\s*/, "")
    .replace(/^[（(][一二三四五六七八九十\d]+[)）]\s*/, "")
    .trim();
  const text = stripped || heading.trim();
  const cut = text.search(PUNCT);
  const head = cut >= 2 ? text.slice(0, cut) : text;
  return Array.from(head)
    .filter((char) => !PUNCT.test(char))
    .join("")
    .trim();
}

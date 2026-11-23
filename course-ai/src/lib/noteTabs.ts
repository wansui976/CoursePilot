/** 标签上写标题的正文：去掉「一、」「1.」「第三章」「（二）」这类编号，只留真正的名字。 */
export function tabLabel(heading: string): string {
  const stripped = heading
    .trim()
    .replace(/^第?[一二三四五六七八九十百零〇\d]+[章节讲部分课]?\s*[、.．:：)）\s]\s*/, "")
    .replace(/^[（(][一二三四五六七八九十\d]+[)）]\s*/, "")
    .trim();
  return stripped || heading.trim();
}

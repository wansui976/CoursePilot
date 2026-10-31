/**
 * 引导收尾「做成复习卡」：按轮次 id 记住已经建过。
 *
 * 卡片组件只在当前挂载内记状态，切走一次会话 / 重启应用后，同一段收尾又会显示
 * 「做成复习卡」，点一下就多出一张重复卡。这里用一份有上限的本地清单兜住。
 */
const KEY = "course-ai-guided-cards";
const MAX_KEYS = 500;

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function guidedCardSaved(turnId: string): boolean {
  return read().includes(turnId);
}

export function markGuidedCardSaved(turnId: string): void {
  try {
    const keys = read();
    if (keys.includes(turnId)) return;
    localStorage.setItem(KEY, JSON.stringify([...keys, turnId].slice(-MAX_KEYS)));
  } catch {
    // 存不下只是下次还能再点一次，不影响这张卡已经建好。
  }
}

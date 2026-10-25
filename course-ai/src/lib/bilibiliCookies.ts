import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/lib/ipc";

/** B 站的 412 / 需要登录 / cookie 相关报错：多半是没导入 cookies，或者导入的已过期。 */
export function looksLikeCookieError(message: string): boolean {
  return /412|precondition|forbidden|403|login|cookie|需要登录|风控/i.test(message);
}

/** 让用户选一份 cookies.txt 并存为 B 站登录凭证。用户取消选择时返回 false。 */
export async function pickBilibiliCookies(): Promise<boolean> {
  const file = await open({
    multiple: false,
    pickerMode: "document",
    filters: [{ name: "cookies.txt", extensions: ["txt"] }],
  });
  if (!file || Array.isArray(file)) return false;
  await ipc.tools.setBilibiliCookies(file);
  return true;
}

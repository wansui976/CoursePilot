/**
 * 助手提问附图的本地存放。
 *
 * 会话正文在 localStorage 里，一张截图的 base64 就有几百 KB，放进去几轮就撑满配额，
 * 所以那边只记张数。原图放 IndexedDB（同在 WebView 的本地存储里，不出设备），按轮次 id 存取，
 * 重启后点开旧提问还能看到当时发的图。
 *
 * 全部是尽力而为：IndexedDB 不可用（隐私模式、测试环境）时读到空、写入静默失败，
 * 界面退回「附了 N 张图（原图未保存）」的说明，不影响对话本身。
 */

const DB_NAME = "course-ai-assistant-images";
const STORE = "turns";

let dbPromise: Promise<IDBDatabase | null> | null = null;
/** 本次运行里存过的轮次。它们的会话快照可能还没落盘，回收时一律跳过。 */
const savedThisRun = new Set<string>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const request = action(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(request ? (request.result ?? null) : null);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function saveTurnImages(turnId: string, images: string[]): Promise<void> {
  if (images.length === 0) return;
  savedThisRun.add(turnId);
  await run("readwrite", (store) => store.put(images, turnId));
}

export async function loadTurnImages(turnId: string): Promise<string[] | null> {
  const value = await run<unknown>("readonly", (store) => store.get(turnId));
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

/** 删掉不再被任何会话引用的轮次的图。会话删除、轮次被裁掉后由这里统一回收。 */
export async function pruneTurnImages(keep: ReadonlySet<string>): Promise<void> {
  const keys = await run<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
  const stale = (keys ?? []).filter(
    (key) => typeof key === "string" && !keep.has(key) && !savedThisRun.has(key),
  );
  if (stale.length === 0) return;
  await run("readwrite", (store) => {
    for (const key of stale) store.delete(key);
  });
}

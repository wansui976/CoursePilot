import type { Folder, ItemRef } from "@/lib/types";

/**
 * 课程内文件夹树的纯函数。后端已把悬空的上级 / 成环的上级归一成根目录（null），
 * 视频指向不存在的文件夹也已归一成 null，这里只管按层取、算路径和计数。
 *
 * 界面约定：同一层里文件夹排在前、视频在后（像 Finder），各自按 order_index 排。
 */

type Placed = { id: string; folder_id?: string | null; order_index: number };

/** 某一层（null = 根目录）的直接子文件夹。 */
export function childFolders(folders: Folder[], parentId: string | null): Folder[] {
  return folders
    .filter((folder) => folder.parent_id === parentId)
    .sort((a, b) => a.order_index - b.order_index || a.created_at - b.created_at);
}

/** 某一层的直接子视频，保持传入顺序（列表接口已按 order_index 排好）。 */
export function childVideos<T extends Placed>(videos: T[], folderId: string | null): T[] {
  return videos.filter((video) => (video.folder_id ?? null) === folderId);
}

/** 从根到该文件夹的路径（含自身）；找不到返回空数组。 */
export function folderPath(folders: Folder[], folderId: string | null): Folder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: Folder[] = [];
  let cursor = folderId ? byId.get(folderId) : undefined;
  while (cursor && !path.includes(cursor)) {
    path.unshift(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return path;
}

/** 文件夹自己加上它下面所有层级的文件夹 id。 */
export function subtreeFolderIds(folders: Folder[], folderId: string): Set<string> {
  const out = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parent_id && out.has(folder.parent_id) && !out.has(folder.id)) {
        out.add(folder.id);
        grew = true;
      }
    }
  }
  return out;
}

/** 文件夹里（含各级子文件夹）一共多少个视频。 */
export function videoCountIn(folders: Folder[], videos: Placed[], folderId: string): number {
  const ids = subtreeFolderIds(folders, folderId);
  return videos.filter((video) => video.folder_id && ids.has(video.folder_id)).length;
}

/** 新文件夹的默认名：同一层里不重名（「新建文件夹」「新建文件夹 2」…）。 */
export function nextFolderName(siblings: Folder[], base: string): string {
  const names = new Set(siblings.map((folder) => folder.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

// 拖放用的键：文件夹和视频的 id 空间不同，加前缀区分；面包屑是放置目标。
export const folderKey = (id: string) => `f:${id}`;
export const videoKey = (id: string) => `v:${id}`;
export const crumbKey = (folderId: string | null) => `c:${folderId ?? ""}`;

export function parseKey(
  key: string,
): { kind: "folder" | "video"; id: string } | { kind: "crumb"; folderId: string | null } | null {
  const id = key.slice(2);
  if (key.startsWith("f:")) return { kind: "folder", id };
  if (key.startsWith("v:")) return { kind: "video", id };
  if (key.startsWith("c:")) return { kind: "crumb", folderId: id || null };
  return null;
}

/** 一层的完整顺序：文件夹在前、视频在后。排序接口要的就是这一层的全部子项。 */
export function containerOrder(folderIds: string[], videoIds: string[]): ItemRef[] {
  return [
    ...folderIds.map((id) => ({ kind: "folder" as const, id })),
    ...videoIds.map((id) => ({ kind: "video" as const, id })),
  ];
}

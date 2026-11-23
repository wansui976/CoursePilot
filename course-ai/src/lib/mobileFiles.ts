import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { copyFile, mkdir } from "@tauri-apps/plugin-fs";

import { isAndroid, isDesktop, isIOS, isMobile } from "./platform";

export { isAndroid };
export { isIOS, isMobile } from "./platform";

export async function pickDirectoryPath(androidSegments: string[] = ["storage"]) {
  if (!isMobile()) {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return null;
    return dir;
  }

  const dir = await join(await appDataDir(), ...androidSegments);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function persistPickedFile(
  pickedPath: string,
  category: string,
  fallbackName: string,
) {
  if (isDesktop()) {
    return pickedPath;
  }

  if (isAndroid() || isIOS()) {
    return invoke<string>("plugin:mobile-files|persist_picked_file", {
      sourceUri: pickedPath,
      category,
      fallbackName,
    });
  }

  {
    const root = await join(await appDataDir(), category);
    await mkdir(root, { recursive: true });
    const dest = await join(root, fallbackName);
    await copyFile(pickedPath, dest);
    return dest;
  }
}

export interface PickPersistedFileResult {
  path: string;
  durationMs: number | null;
}

export async function mobileCategoryDir(category: string) {
  const root = await join(await appDataDir(), category);
  await mkdir(root, { recursive: true });
  return root;
}

export async function shareFile(sourcePath: string, mime: string) {
  if (isAndroid() || isIOS()) {
    return invoke<void>("plugin:mobile-files|share_file", {
      sourcePath,
      mime,
    });
  }
  return Promise.resolve();
}

export interface PersistedFilePickOptions {
  category: string;
  fallbackName: string;
  filters: { name: string; extensions: string[] }[];
  prompt?: string;
}

/** 用数据线从电脑拷进来的文件：iOS 在 App「文稿」里，Android 在 App 媒体目录的「导入」文件夹里。 */
export interface CableFile {
  name: string;
  path: string;
  size: number;
  /** 几秒内刚改过：电脑那头可能还在写，先别导入。 */
  settling?: boolean;
}

export interface CableScan {
  files: CableFile[];
  /** 文件夹里一共看到的文件数：用来区分「没拷进来」和「格式不对」。 */
  scanned: number;
  /** Android：「导入」文件夹从「内部存储」往下的路径（如 Android/media/dev.courseai.app/导入）。 */
  folder?: string | null;
}

/** 数据线导入只有手机 / 平板有：桌面上的文件本来就在本机，直接选文件导入。 */
export function cableImportAvailable() {
  return isIOS() || isAndroid();
}

export async function listCableFiles(): Promise<CableScan> {
  if (!cableImportAvailable()) return { files: [], scanned: 0 };
  return invoke<CableScan>("plugin:mobile-files|list_cable_files");
}

/** 把拷进来的文件移进 App 资料库，返回移动后的路径和时长。 */
export async function takeCableFile(
  sourcePath: string,
  category: string,
): Promise<PickPersistedFileResult | null> {
  if (!cableImportAvailable()) return null;
  return invoke<PickPersistedFileResult | null>("plugin:mobile-files|take_cable_file", {
    sourcePath,
    category,
  });
}

/** 文件已经移进资料库、加进课程却失败了：放回原来的文件夹，下次还能在列表里看到。 */
export async function returnCableFile(path: string): Promise<string | null> {
  if (!cableImportAvailable()) return null;
  return invoke<string | null>("plugin:mobile-files|return_cable_file", { path });
}

export async function pickPersistedFile({
  category,
  fallbackName,
  filters,
  prompt,
}: PersistedFilePickOptions): Promise<PickPersistedFileResult | null> {
  if (isIOS()) {
    const result = await invoke<PickPersistedFileResult | null>(
      "plugin:mobile-files|pick_and_persist_file",
      {
        category,
        fallbackName,
        allowedExtensions: filters.flatMap((filter) => filter.extensions),
        prompt,
      },
    );
    return result;
  }

  const file = await open({
    directory: false,
    multiple: false,
    pickerMode: "document",
    filters,
  });
  if (!file || Array.isArray(file)) return null;
  const path = await persistPickedFile(file, category, fallbackName);
  return { path, durationMs: null };
}

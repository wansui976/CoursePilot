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

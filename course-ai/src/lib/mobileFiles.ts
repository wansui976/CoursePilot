import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { copyFile, mkdir } from "@tauri-apps/plugin-fs";

import { isAndroid, isDesktop, isMobile } from "./platform";

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

  if (!isAndroid()) {
    const root = await join(await appDataDir(), category);
    await mkdir(root, { recursive: true });
    const dest = await join(root, fallbackName);
    await copyFile(pickedPath, dest);
    return dest;
  }

  return invoke<string>("plugin:mobile-files|persist_picked_file", {
    sourceUri: pickedPath,
    category,
    fallbackName,
  });
}

export async function mobileCategoryDir(category: string) {
  const root = await join(await appDataDir(), category);
  await mkdir(root, { recursive: true });
  return root;
}

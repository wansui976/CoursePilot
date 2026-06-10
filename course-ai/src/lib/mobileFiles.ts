import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir } from "@tauri-apps/plugin-fs";

export const isAndroid = /Android/i.test(navigator.userAgent);

export async function pickDirectoryPath(androidSegments: string[] = ["storage"]) {
  if (!isAndroid) {
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
  if (!isAndroid) {
    return pickedPath;
  }

  return invoke<string>("plugin:mobile-files|persist_picked_file", {
    sourceUri: pickedPath,
    category,
    fallbackName,
  });
}

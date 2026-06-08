import { invoke } from "@tauri-apps/api/core";

export const isAndroid = /Android/i.test(navigator.userAgent);

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

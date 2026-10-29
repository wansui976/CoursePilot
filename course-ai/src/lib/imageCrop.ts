import { fitWithin } from "@/lib/assistantImages";

/** 归一化（0–1）的框选区域。 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 太小的框（误触）当成没框，用整张图。 */
const MIN_CROP = 0.04;

/** 拖拽起点、终点（归一化坐标）→ 规整成左上角 + 宽高，并夹到图内。 */
export function normalizeCrop(ax: number, ay: number, bx: number, by: number): CropRect | null {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x1 = clamp(Math.min(ax, bx));
  const y1 = clamp(Math.min(ay, by));
  const x2 = clamp(Math.max(ax, bx));
  const y2 = clamp(Math.max(ay, by));
  if (x2 - x1 < MIN_CROP || y2 - y1 < MIN_CROP) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 按框裁出一张新图（JPEG data URL），长边不超过 2048。 */
export async function cropDataUrl(src: string, rect: CropRect): Promise<string> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("图片读不出来"));
    element.src = src;
  });
  const sx = Math.round(rect.x * image.naturalWidth);
  const sy = Math.round(rect.y * image.naturalHeight);
  const sw = Math.max(1, Math.round(rect.w * image.naturalWidth));
  const sh = Math.max(1, Math.round(rect.h * image.naturalHeight));
  const target = fitWithin(sw, sh);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片读不出来");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(image, sx, sy, sw, sh, 0, 0, target.width, target.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

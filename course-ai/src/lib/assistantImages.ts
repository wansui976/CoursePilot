/**
 * 助手提问附带的图片：从剪贴板/文件选择拿到原图，压到适合发给模型的大小，转成 data URL。
 *
 * 为什么要压：截图动辄 4K、好几 MB，原样 base64 发出去请求体会大得离谱，
 * 模型端点也会按像素计费——而长边 2048 已经足够看清课件和题目里的字。
 */

export const MAX_ASSISTANT_IMAGES = 4;
/** 长边上限。多数视觉模型内部也会缩到这个量级，再大只是白花流量和钱。 */
export const MAX_IMAGE_EDGE = 2048;
/** 原图不超过这个大小、尺寸也不超限时原样发送，不重新编码（截图里的字会更清楚）。 */
const PASSTHROUGH_BYTES = 1.5 * 1024 * 1024;
const PASSTHROUGH_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const JPEG_QUALITY = 0.9;

export interface AssistantImage {
  id: string;
  /** data:image/...;base64,... */
  dataUrl: string;
}

export class AssistantImageError extends Error {
  constructor(readonly reason: "unsupported" | "decode") {
    super(reason);
  }
}

/** 等比缩放到长边不超过 maxEdge；本来就够小时原样返回。 */
export function fitWithin(width: number, height: number, maxEdge = MAX_IMAGE_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 从粘贴事件里取出图片文件。剪贴板里同时有文字和图片时只拿图片，文字照常粘贴。 */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AssistantImageError("decode"));
    reader.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new AssistantImageError("decode"));
    image.src = url;
  });
}

/** 把一张图片文件转成要发给模型的 data URL：小图原样，大图缩放后转 JPEG。 */
export async function prepareAssistantImage(file: Blob): Promise<string> {
  if (!file.type.startsWith("image/")) throw new AssistantImageError("unsupported");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const { naturalWidth: width, naturalHeight: height } = image;
    const target = fitWithin(width, height);
    const fits = target.width === width && target.height === height;
    if (fits && file.size <= PASSTHROUGH_BYTES && PASSTHROUGH_TYPES.has(file.type)) {
      return await readAsDataUrl(file);
    }
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new AssistantImageError("decode");
    // JPEG 没有透明通道，透明截图直接转会变黑底；先铺白。
    context.fillStyle = "#fff";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(image, 0, 0, target.width, target.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

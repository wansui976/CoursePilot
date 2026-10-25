/**
 * 把要插进笔记的图片整理成能存、能同步的样子。
 *
 * 云同步一条记录最多 1MB，图片以 base64 进去会膨胀 4/3，所以落库前压到 TARGET_BYTES 以内。
 * 本来就够小的图原样保留（截图里的文字不糊、GIF 还能动）；大图先缩到 MAX_EDGE，
 * 截图类的 PNG 先试 PNG，不够再转 JPEG 逐级降质，最后才继续缩尺寸。
 */
export const TARGET_BYTES = 560 * 1024;
const MAX_EDGE = 2000;
const KEEP_MAX_EDGE = 2400;
const KEEP_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const JPEG_QUALITIES = [0.9, 0.82, 0.72, 0.6];

export interface PreparedImage {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
}

export class ImageTooLargeError extends Error {}

async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encode(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas encode failed"))),
      mime,
      quality,
    );
  });
}

function draw(source: CanvasImageSource, width: number, height: number, opaque: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  if (opaque) {
    // JPEG 没有透明通道：透明处默认会变黑，垫白底。
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

export async function prepareImage(input: Blob): Promise<PreparedImage> {
  const decoded = await decode(input);
  try {
    const { width, height } = decoded;
    if (
      KEEP_TYPES.includes(input.type) &&
      input.size <= TARGET_BYTES &&
      Math.max(width, height) <= KEEP_MAX_EDGE
    ) {
      return { blob: input, mime: input.type, width, height };
    }

    let scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      if (input.type === "image/png") {
        const png = await encode(draw(decoded.source, w, h, false), "image/png");
        if (png.size <= TARGET_BYTES) return { blob: png, mime: "image/png", width: w, height: h };
      }
      const canvas = draw(decoded.source, w, h, true);
      for (const quality of JPEG_QUALITIES) {
        const jpeg = await encode(canvas, "image/jpeg", quality);
        if (jpeg.size <= TARGET_BYTES) return { blob: jpeg, mime: "image/jpeg", width: w, height: h };
      }
      scale *= 0.7;
    }
    throw new ImageTooLargeError("image still too large after compression");
  } finally {
    decoded.close();
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

/**
 * 点开附图看大图。多张时左右键/按钮切换，Esc、点空白处关闭。
 * 用全屏深色遮罩而不是普通对话框：截图里的字要尽可能大地看清。
 */
export function ImageLightbox({
  images,
  index,
  onClose,
}: {
  images: string[];
  /** 打开时显示哪一张；null 表示关着。 */
  index: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(index ?? 0);
  const open = index !== null && images.length > 0;
  const count = images.length;

  useEffect(() => {
    if (index !== null) setCurrent(index);
  }, [index]);

  const step = (delta: number) => setCurrent((value) => (value + delta + count) % count);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="ca-dialog-overlay fixed inset-0 z-[80] bg-black/85" />
        <Dialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          onKeyDown={(event) => {
            // 查看器挂在 body 上，但 React 事件仍沿组件树冒泡：不拦的话 Esc 会接着冒到
            // 助手面板，把整块面板也收起来。Radix 自己的 Esc 关闭走 document 监听，不受影响。
            event.stopPropagation();
            if (count < 2) return;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              step(-1);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              step(1);
            }
          }}
          onClick={(event) => {
            // 点图片以外的地方关闭；点图片本身不关，方便细看。
            if (event.target === event.currentTarget) onClose();
          }}
          className="fixed inset-0 z-[81] flex items-center justify-center p-6 outline-none sm:p-12"
        >
          <Dialog.Title className="sr-only">
            {t("assistant.imageViewerTitle", { index: current + 1, count })}
          </Dialog.Title>
          {open && (
            <img
              src={images[current]}
              alt={t("assistant.attachedImageAlt", { index: current + 1 })}
              className="max-h-full max-w-full rounded-lg object-contain shadow-[var(--shadow-pop)]"
            />
          )}
          <Dialog.Close
            aria-label={t("assistant.closeImageViewer")}
            className="absolute right-4 top-[max(1rem,var(--safe-top,0px))] grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Dialog.Close>
          {count > 1 && (
            <>
              <button
                type="button"
                aria-label={t("assistant.previousImage")}
                onClick={() => step(-1)}
                className="absolute left-4 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <ChevronLeft className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={t("assistant.nextImage")}
                onClick={() => step(1)}
                className="absolute right-4 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <ChevronRight className="h-5 w-5" aria-hidden="true" />
              </button>
              <span className="absolute bottom-[max(1rem,var(--safe-bottom,0px))] left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1 text-xs text-white">
                {current + 1} / {count}
              </span>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

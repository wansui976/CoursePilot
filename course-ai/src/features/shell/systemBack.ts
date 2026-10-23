import { onBackButtonPress } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef } from "react";
import { ipc } from "@/lib/ipc";

/**
 * 「返回」与显式导航前的收尾：先关掉最上层的临时态，再谈换页。
 *
 * 临时态由各子组件自己管理（菜单、导入任务、移动助手、复习模态、全屏播放器……），
 * 外壳不认识它们，只按 DOM 约定找到最上层那一个、发 Esc 让它自己决定关闭或拦截：
 *   - `[role="menu"]`、`[data-system-back-layer]`、`[role="dialog"][aria-modal="true"]`；
 *   - 层上带 `data-system-back-pending` / `data-system-back-dirty` 表示「这次不能直接关」，
 *     导航就此截断，不再继续；
 *   - 页面级的临时态（课程库的多选、重命名等）用 registerTransientClose 登记关闭函数。
 *
 * dismissVisibleTransient(continuation) 关掉一层后，若还有可见临时态就继续逐层关闭，
 * 全部关完才执行 continuation；返回 false 表示本来就没有可关的临时态。
 */
export function useTransientDismissal({ videoFullscreen }: { videoFullscreen: boolean }) {
  const transientCloseRef = useRef<(() => HTMLElement | null | void) | null>(null);
  const dismissVisibleTransientRef = useRef<
    ((continuation?: () => void) => boolean) | null
  >(null);
  const registerTransientClose = useCallback(
    (close: (() => HTMLElement | null | void) | null) => {
      transientCloseRef.current = close;
    },
    [],
  );

  const dismissVisibleTransient = useCallback(
    (continuation?: () => void): boolean => {
      const visibleMenus = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menu"]:not([hidden])'),
      ).filter(
        (menu) =>
          !menu.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]'),
      );
      const dispatchEscape = (target: HTMLElement | Document) => {
        const escape = new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(escape);
        return escape.defaultPrevented;
      };

      const visibleTransientLayers = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-system-back-layer]:not([hidden])',
        ),
      ).filter(
        (layer) =>
          !layer.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]'),
      );

      // 子组件自己的全屏模态（复习、移动助手、未保存确认、导入任务）比 Home
      // 的页面层级更靠上。把 Android 返回等价成 Esc，让模态自行决定关闭或拦截。
      const visibleModals = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]:not([hidden])',
        ),
      ).filter(
        (modal) =>
          !modal.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]'),
      );
      const modal = visibleModals[visibleModals.length - 1];

      const continueAfterDismissal = (target?: HTMLElement | null) => {
        if (
          !continuation ||
          target?.hasAttribute("data-system-back-pending") ||
          target?.hasAttribute("data-system-back-dirty")
        ) {
          return;
        }
        queueMicrotask(() => {
          const stillVisible =
            target?.isConnected &&
            !target.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]');
          if (stillVisible) return;
          // 显式导航可能叠着多层（例如移动助手盖在文稿编辑器上）：逐层关闭，
          // 直到没有可见临时态才执行原导航；dirty / pending 层会在上面直接截断。
          if (dismissVisibleTransientRef.current?.(continuation)) return;
          continuation();
        });
      };

      // 全屏播放器在模态助手之上；先关其内部菜单，再退出全屏。
      if (videoFullscreen) {
        const fullscreenLayer =
          document.querySelector<HTMLElement>("[data-video-fullscreen]");
        const fullscreenMenu = [...visibleMenus]
          .reverse()
          .find((menu) => fullscreenLayer?.contains(menu));
        if (fullscreenMenu && dispatchEscape(fullscreenMenu)) {
          continueAfterDismissal(fullscreenMenu);
          return true;
        }
        const fullscreenTransient = [...visibleTransientLayers]
          .reverse()
          .find((layer) => fullscreenLayer?.contains(layer));
        if (fullscreenTransient && dispatchEscape(fullscreenTransient)) {
          continueAfterDismissal(fullscreenTransient);
          return true;
        }
        dispatchEscape(document);
        continueAfterDismissal(fullscreenLayer);
        return true;
      }

      // 模态内的菜单/临时层比模态本身更靠上；页面背后的临时层不能抢先消费返回。
      if (modal) {
        const modalMenu = [...visibleMenus]
          .reverse()
          .find((menu) => modal.contains(menu));
        if (modalMenu && dispatchEscape(modalMenu)) {
          continueAfterDismissal(modalMenu);
          return true;
        }
        const modalTransient = [...visibleTransientLayers]
          .reverse()
          .find((layer) => modal.contains(layer));
        if (modalTransient && dispatchEscape(modalTransient)) {
          continueAfterDismissal(modalTransient);
          return true;
        }
        dispatchEscape(modal);
        continueAfterDismissal(modal);
        return true;
      }

      if (transientCloseRef.current) {
        const closed = transientCloseRef.current();
        continueAfterDismissal(closed ?? undefined);
        return true;
      }


      // 导入、导出和倍速等页面菜单由子组件管理。Android 返回等价成 Escape。
      const menu = visibleMenus[visibleMenus.length - 1];
      if (menu && dispatchEscape(menu)) {
        continueAfterDismissal(menu);
        return true;
      }

      const transientLayer = visibleTransientLayers[visibleTransientLayers.length - 1];
      if (transientLayer && dispatchEscape(transientLayer)) {
        continueAfterDismissal(transientLayer);
        return true;
      }

      return false;
    },
    [
      videoFullscreen,
    ],
  );
  dismissVisibleTransientRef.current = dismissVisibleTransient;

  return { dismissVisibleTransient, registerTransientClose };
}

/**
 * Android 的硬件返回键与窗口关闭：交给 goBackOneLevel 退一级。退到底时返回键把应用
 * 退到后台（与系统对根 Activity 的默认做法一致）：直接退出会把正在跑的处理任务一起杀掉。
 * 硬件返回键是「平台能力」（仅 Android 有），与布局宽度无关：用 UA 判平台，避免在
 * 桌面拦截窗口关闭。
 */
export function useAndroidBack(goBackOneLevel: () => boolean) {
  const isAndroidPlatform =
    typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

  useEffect(() => {
    if (!isAndroidPlatform) return;

    let cancelled = false;
    let closeListener: (() => void) | null = null;
    let backListener: { unregister: () => Promise<void> } | null = null;

    void (async () => {
      closeListener = await getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        if (!goBackOneLevel()) void ipc.app.exit();
      });
      backListener = await onBackButtonPress(() => {
        if (!goBackOneLevel()) void ipc.app.moveToBackground();
      });
      if (cancelled) {
        closeListener?.();
        void backListener.unregister();
      }
    })();

    return () => {
      cancelled = true;
      closeListener?.();
      void backListener?.unregister();
    };
  }, [goBackOneLevel, isAndroidPlatform]);
}

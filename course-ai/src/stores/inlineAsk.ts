import { create } from "zustand";

/** 就地追问的待处理上下文：用户在文稿里选中的一段文字 + 其所在句的时间戳。 */
export interface AskContext {
  text: string;
  startMs: number | null;
  /** 「引导我理解」：带着这段话打开引导模式，而不是直接解释。 */
  mode?: "socratic";
  /** problem：这是一道题（拍题找讲解交过来的），问法换成「这道题怎么做」。 */
  template?: "problem";
  /** 随这一问带上的图（题目照片）。 */
  images?: string[];
}

interface InlineAskState {
  pending: AskContext | null;
  /** 发起「就所选内容提问」：空白选区忽略。消费方（提问面板）读取后调用 clear。 */
  askAbout: (
    text: string,
    startMs: number | null,
    mode?: "socratic",
    extra?: { template?: "problem"; images?: string[] },
  ) => void;
  clear: () => void;
}

export const useInlineAsk = create<InlineAskState>((set) => ({
  pending: null,
  askAbout: (text, startMs, mode, extra) => {
    const trimmed = text.trim();
    if (!trimmed && !extra?.images?.length) return;
    set({
      pending: {
        text: trimmed,
        startMs,
        ...(mode ? { mode } : {}),
        ...(extra?.template ? { template: extra.template } : {}),
        ...(extra?.images?.length ? { images: extra.images } : {}),
      },
    });
  },
  clear: () => set({ pending: null }),
}));

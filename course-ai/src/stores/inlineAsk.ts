import { create } from "zustand";

/** 就地追问的待处理上下文：用户在文稿里选中的一段文字 + 其所在句的时间戳。 */
export interface AskContext {
  text: string;
  startMs: number | null;
  /** 「引导我理解」：带着这段话打开引导模式，而不是直接解释。 */
  mode?: "socratic";
}

interface InlineAskState {
  pending: AskContext | null;
  /** 发起「就所选内容提问」：空白选区忽略。消费方（提问面板）读取后调用 clear。 */
  askAbout: (text: string, startMs: number | null, mode?: "socratic") => void;
  clear: () => void;
}

export const useInlineAsk = create<InlineAskState>((set) => ({
  pending: null,
  askAbout: (text, startMs, mode) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set({ pending: { text: trimmed, startMs, ...(mode ? { mode } : {}) } });
  },
  clear: () => set({ pending: null }),
}));

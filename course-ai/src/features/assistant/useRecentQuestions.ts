import { useState, type KeyboardEvent, type RefObject } from "react";
import {
  appendRecentAssistantQuestion,
  readRecentAssistantQuestions,
} from "@/lib/assistantConversations";

/**
 * 输入框里按 ↑ / ↓ 翻最近问过的问题（像终端历史）。
 *
 * 翻看期间输入框显示的是历史问题，真正的草稿另存一份：持久化与「翻回底」都用它。
 * 只依赖 setState 与 ref 这类稳定引用，所以返回的对象整个生命周期不变，可以放进 effect 依赖。
 */
export function useRecentQuestions(options: {
  initialDraft: string;
  setInput: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [api] = useState(() => createRecentQuestions(options));
  return api;
}

function createRecentQuestions({
  initialDraft,
  setInput,
  inputRef,
}: {
  initialDraft: string;
  setInput: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const questionsRef = { current: readRecentAssistantQuestions() };
  const indexRef: { current: number | null } = { current: null };
  const draftRef = { current: initialDraft };

  /** 结束翻看：此后输入框里的内容就是草稿本身。 */
  function reset(draft: string) {
    indexRef.current = null;
    draftRef.current = draft;
  }

  function moveCaretToEnd() {
    requestAnimationFrame(() => {
      const textarea = inputRef.current;
      if (!textarea) return;
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  }

  /** 处理了这次按键就返回 true，调用方不再当普通输入处理。 */
  function navigate(event: KeyboardEvent<HTMLTextAreaElement>) {
    const currentIndex = indexRef.current;
    if (
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return false;
    }

    if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
      if (currentIndex != null) reset(event.currentTarget.value);
      return false;
    }
    // 召回后光标会停在末尾，连续上下键继续浏览；一旦用户把光标移进文本中间，
    // 就把当前内容当成普通草稿，方向键交还给 textarea 的多行编辑。
    if (currentIndex != null && event.currentTarget.selectionStart !== event.currentTarget.value.length) {
      reset(event.currentTarget.value);
      return false;
    }

    const questions = questionsRef.current;
    if (event.key === "ArrowUp") {
      if (questions.length === 0 || (currentIndex == null && event.currentTarget.selectionStart !== 0)) {
        return false;
      }
      if (currentIndex == null) draftRef.current = event.currentTarget.value;
      const nextIndex = Math.max(0, (currentIndex ?? questions.length) - 1);
      event.preventDefault();
      indexRef.current = nextIndex;
      setInput(questions[nextIndex]);
      moveCaretToEnd();
      return true;
    }

    if (currentIndex == null) return false;
    event.preventDefault();
    if (currentIndex < questions.length - 1) {
      const nextIndex = currentIndex + 1;
      indexRef.current = nextIndex;
      setInput(questions[nextIndex]);
    } else {
      indexRef.current = null;
      setInput(draftRef.current);
    }
    moveCaretToEnd();
    return true;
  }

  function remember(question: string) {
    questionsRef.current = appendRecentAssistantQuestion(question);
  }

  /** 该存进会话草稿的内容：翻看历史时存翻看前的草稿，而不是正在显示的旧问题。 */
  function persistedDraft(input: string) {
    return indexRef.current == null ? input : draftRef.current;
  }

  function stopBrowsing() {
    indexRef.current = null;
  }

  return { reset, navigate, remember, persistedDraft, moveCaretToEnd, stopBrowsing };
}

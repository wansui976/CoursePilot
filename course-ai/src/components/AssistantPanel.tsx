import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssistantActionCard } from "@/components/AssistantActionCard";
import { ipc } from "@/lib/ipc";
import { isMobile } from "@/lib/platform";
import { useAssistantUi } from "@/stores/assistant";
import type { AssistantAction, AssistantContext, AssistantMessage } from "@/lib/types";

/**
 * 常驻的全局助手面板。
 *
 * 桌面端吸附在左右任一边缘，收起时缩成一个小球；手机端没有「边缘停靠」的余地，
 * 改成底部抽屉——两种外壳共用同一套状态和消息流，切换的只是容器。
 */

interface Turn {
  id: string;
  question: string;
  answer: string;
  actions: AssistantAction[];
  tools: string[];
  /** 这一轮来回了几次。花了多少钱要让人看得见。 */
  turns: number;
}

export function AssistantPanel({
  context,
  onNavigate,
}: {
  context: AssistantContext;
  /** 打开视频 / 跳转由外层执行——只有它知道播放器和路由。 */
  onNavigate: (action: AssistantAction) => void;
}) {
  const { open, side, setOpen, dock } = useAssistantUi();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<AssistantMessage[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const mobile = isMobile();

  useEffect(() => {
    // 新一轮出来就滚到底，否则答案出现在视野外，看起来像没反应。
    // 直接写 scrollTop 而不是 scrollTo：后者在 jsdom 里根本不存在，
    // 而这行代码没必要为了一个平滑动画就在测试环境里炸掉。
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns, busy]);

  async function send() {
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);
    setError("");
    try {
      const reply = await ipc.assistant.ask(question, context, history);
      setHistory(reply.history);
      setTurns((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          question,
          answer: reply.answer,
          actions: reply.actions,
          tools: reply.tools_used,
          turns: reply.turns,
        },
      ]);
    } catch (e) {
      // 把问题放回输入框：让用户能直接重发，而不是重新打一遍。
      setInput(question);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        aria-label="打开助手"
        onClick={() => setOpen(true)}
        className={`ca-touch-44 fixed bottom-6 z-40 grid h-12 w-12 place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-lg transition hover:bg-[var(--surface-card-hover)] ${
          side === "left" ? "left-4" : "right-4"
        }`}
      >
        <Sparkles className="h-5 w-5 text-[var(--accent)]" />
      </button>
    );
  }

  const shell = mobile
    ? "fixed inset-x-0 bottom-0 z-40 h-[70vh] rounded-t-2xl border-t"
    : `fixed bottom-4 top-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border ${
        side === "left" ? "left-4" : "right-4"
      }`;

  return (
    <aside
      aria-label="助手"
      className={`${shell} flex flex-col border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-xl`}
    >
      <header className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-2">
        <Sparkles className="h-4 w-4 flex-none text-[var(--accent)]" />
        <span className="flex-1 text-sm font-medium text-[var(--text-strong)]">助手</span>
        {/* 手机端没有左右可停靠的空间，只有桌面端给这个按钮。 */}
        {!mobile && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={side === "left" ? "停靠到右边" : "停靠到左边"}
            onClick={() => dock(side === "left" ? "right" : "left")}
          >
            {side === "left" ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        )}
        <Button size="icon" variant="ghost" aria-label="收起助手" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 && !busy && (
          <p className="text-xs text-[var(--text-faint)]">
            可以问「这门课哪讲了梯度下降」「跳到讲例题的地方」，
            也可以说「把这个视频改名叫第三讲」——改动类的会先给你一张确认卡。
          </p>
        )}
        {turns.map((turn) => (
          <div key={turn.id} className="space-y-1.5">
            <p className="text-right text-xs text-[var(--text-muted)]">{turn.question}</p>
            {turn.answer && (
              <p className="whitespace-pre-wrap text-sm text-[var(--text-normal)]">
                {turn.answer}
              </p>
            )}
            {turn.actions
              .map((action, i) => ({ action, key: `${turn.id}-${i}` }))
              .filter(({ key }) => !dismissed.has(key))
              .map(({ action, key }) => (
                <AssistantActionCard
                  key={key}
                  action={action}
                  onNavigate={onNavigate}
                  onDismiss={() =>
                    setDismissed((prev) => new Set(prev).add(key))
                  }
                />
              ))}
            {turn.tools.length > 0 && (
              // 调了什么、来回几次，都摆出来。工具循环每一轮的结果都留在上下文里，
              // 花销是乘法涨的，不该是笔糊涂账。
              <p className="text-[10px] text-[var(--text-faint)]">
                用了 {turn.tools.join("、")}，{turn.turns} 轮
              </p>
            )}
          </div>
        ))}
        {busy && <p className="text-xs text-[var(--text-faint)]">正在想…</p>}
        {error && (
          <p role="alert" className="text-xs text-[var(--status-err)]">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-[var(--border-subtle)] p-2">
        <textarea
          aria-label="对助手说"
          rows={1}
          value={input}
          placeholder="想做什么？"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行。输入法组词时的 Enter 不能当发送，
            // 否则中文用户每选一次候选词就误发一条。
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="max-h-24 flex-1 resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2.5 py-2 text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)]"
        />
        <Button size="icon" aria-label="发送" disabled={busy || !input.trim()} onClick={send}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </aside>
  );
}

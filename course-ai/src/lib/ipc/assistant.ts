/** AI 助手对话与动作执行。 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AssistantContext,
  AssistantEvent,
  AssistantMessage,
  AssistantReply,
} from "../types";

type AssistantRequestState = {
  cancelRequested: boolean;
  askSettled: boolean;
  askReady: Promise<void>;
  resolveAskReady: () => void;
  replayCancel?: Promise<void>;
};

// `cmd_assistant_ask` registers the request after the frontend has installed its
// listener. A stop click can arrive in that small window, so remember the intent
// locally and replay the cancellation once the ask command has returned.
const assistantRequestStates = new Map<string, AssistantRequestState>();

export const assistant = {
  /**
   * 问一句，流式。history 传上一轮返回的 history 即可续聊；requestId 用来精确停止这一轮。
   *
   * 与问答那条流一样：命令立刻返回、活儿在后台跑，事件（含最终 done / error）实时到达。
   * 先注册监听再 invoke，避免漏掉早到的事件。
   */
  ask: async (
    query: string,
    context: AssistantContext | undefined,
    history: AssistantMessage[] | undefined,
    requestId: string,
    onEvent: (e: AssistantEvent) => void = () => {},
  ): Promise<AssistantReply> => {
    let resolveAskReady!: () => void;
    const askReady = new Promise<void>((resolve) => {
      resolveAskReady = resolve;
    });
    const requestState: AssistantRequestState = {
      cancelRequested: false,
      askSettled: false,
      askReady,
      resolveAskReady,
    };
    assistantRequestStates.set(requestId, requestState);
    let resolveReply!: (reply: AssistantReply) => void;
    let rejectReply!: (error: unknown) => void;
    const reply = new Promise<AssistantReply>((res, rej) => {
      resolveReply = res;
      rejectReply = rej;
    });
    // A command/configuration error can reject before `reply` is awaited. Attach
    // a sink immediately so that an early event error never becomes unhandled.
    void reply.catch(() => {});
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<AssistantEvent>(
        `assistant-stream:${requestId}`,
        (evt) => {
          const e = evt.payload;
          if (e.type === "done") resolveReply(e.reply);
          else if (e.type === "error") rejectReply(new Error(e.message));
          else onEvent(e);
        },
      );
      // 命令本身只在「未配置大模型」这类配置错误时才 reject。
      await invoke("cmd_assistant_ask", { query, context, history, requestId });
      requestState.askSettled = true;
      if (requestState.cancelRequested) {
        // The first cancel may have run before the backend registered this id.
        // Replay it after the ask command has completed registration. A failed
        // replay must not tear down the stream: the backend may still be running,
        // and its eventual done/error event is the only trustworthy terminal state.
        requestState.replayCancel = invoke<void>("cmd_cancel_assistant", {
          requestId,
        });
        void requestState.replayCancel.catch(() => {});
      }
      requestState.resolveAskReady();
      // cancel() exposes replay failures to the caller. The stream must not await
      // that transport call: done/error still has to settle and release the listener
      // even if the cancel invoke itself never returns.
      return await reply;
    } finally {
      requestState.askSettled = true;
      requestState.resolveAskReady();
      // invoke 自身失败时直接沿用它的拒绝；不能再 reject 尚无人等待的 reply，
      // 否则同一个配置错误会额外制造一条 unhandledRejection。
      if (assistantRequestStates.get(requestId) === requestState) {
        assistantRequestStates.delete(requestId);
      }
      unlisten?.();
    }
  },
  cancel: async (requestId: string): Promise<void> => {
    const requestState = assistantRequestStates.get(requestId);
    if (!requestState) {
      return invoke("cmd_cancel_assistant", { requestId });
    }

    const needsReplay = !requestState.askSettled;
    requestState.cancelRequested = true;
    const initial = invoke<void>("cmd_cancel_assistant", { requestId }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (needsReplay) {
      await requestState.askReady;
      if (requestState.replayCancel) return requestState.replayCancel;
    }

    const outcome = await initial;
    if (!outcome.ok) throw outcome.error;
  },
};

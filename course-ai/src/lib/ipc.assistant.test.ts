import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import type { AssistantEvent, AssistantReply } from "./types";

const { invokeMock, listenMock, unlistenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

function reply(): AssistantReply {
  return {
    answer: "答复",
    canceled: false,
    hit_turn_limit: false,
    actions: [],
    turns: 1,
    tools_used: [],
    history: [],
  };
}

describe("ipc.assistant", () => {
  let emit!: (event: { payload: AssistantEvent }) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    emit = undefined as never;
    listenMock.mockImplementation(async (_name: string, handler: typeof emit) => {
      emit = handler;
      return unlistenMock;
    });
    invokeMock.mockResolvedValue(undefined);
  });

  it("记住早于后端登记的停止，并在 ask 返回后补发取消", async () => {
    let releaseAsk!: () => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "cmd_assistant_ask") {
        return new Promise<void>((resolve) => {
          releaseAsk = resolve;
        });
      }
      return Promise.resolve();
    });

    const pending = ipc.assistant.ask("查一下", undefined, [], "request-1");
    await vi.waitFor(() => expect(releaseAsk).toBeTypeOf("function"));

    await ipc.assistant.cancel("request-1");
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "cmd_cancel_assistant"),
    ).toHaveLength(1);

    releaseAsk();
    await vi.waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "cmd_cancel_assistant"),
      ).toHaveLength(2),
    );

    emit({ payload: { type: "done", reply: reply() } });
    await expect(pending).resolves.toMatchObject({ answer: "答复" });
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it("命令在监听后立即失败时直接抛错，并清理监听而不制造未处理拒绝", async () => {
    invokeMock.mockImplementationOnce(async (command: string) => {
      if (command === "cmd_assistant_ask") throw new Error("尚未配置模型");
      return undefined;
    });

    await expect(ipc.assistant.ask("查一下", undefined, [], "request-2")).rejects.toThrow(
      "尚未配置模型",
    );
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });
});

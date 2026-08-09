import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendRecentAssistantQuestion,
  assistantConversationsStorageKey,
  assistantConversationStorageKey,
  assistantRecentQuestionsStorageKey,
  createAssistantConversation,
  deleteAssistantConversation,
  MAX_ASSISTANT_CONVERSATIONS,
  MAX_ASSISTANT_CONVERSATION_TITLE_CHARS,
  readAssistantConversation,
  readAssistantConversations,
  readRecentAssistantQuestions,
  renameAssistantConversation,
  saveAssistantConversation,
  setActiveAssistantConversation,
  tryCreateAssistantConversation,
  trySetActiveAssistantConversation,
  upsertAssistantConversation,
  writeRecentAssistantQuestions,
} from "./assistantConversations";
import {
  assistantSessionStorageKey,
  MAX_ASSISTANT_ANSWER_CHARS,
  MAX_ASSISTANT_PROMPT_CHARS,
  MAX_ASSISTANT_PROMPT_HISTORY,
  type AssistantSession,
  writeAssistantSession,
} from "./assistantSession";

function session(question: string, answer = `回答：${question}`): AssistantSession {
  return {
    turns: [
      {
        id: `turn-${question}`,
        question,
        answer,
        actions: [],
        tools: [],
        canceled: false,
        actionResults: [],
      },
    ],
    history: [
      { role: "user", content: question },
      { role: "assistant", content: answer },
    ],
    draft: "",
  };
}

describe("assistantConversations", () => {
  beforeEach(() => localStorage.clear());

  it("migrates the legacy session once and keeps actions non-executable", () => {
    writeAssistantSession(
      {
        turns: [
          {
            id: "legacy-turn",
            question: "删除第一讲",
            answer: "请确认",
            actions: [{ kind: "propose_delete", video_id: "video-1", title: "第一讲" }],
            tools: [],
            canceled: false,
            actionResults: [],
          },
        ],
        history: [
          { role: "user", content: "删除第一讲" },
          { role: "assistant", content: "请确认" },
        ],
        draft: "稍后再问",
      },
      1_000,
    );

    const migrated = readAssistantConversations(1_001);
    const id = migrated.activeId as string;
    expect(migrated.conversations).toEqual([
      { id, title: "删除第一讲", updatedAt: 1_001 },
    ]);
    expect(readAssistantConversation(id, 1_002)?.session).toMatchObject({
      turns: [
        {
          id: "legacy-turn",
          actions: [],
          actionsExpired: true,
          checkpoint: { expiredReason: "restart" },
        },
      ],
      draft: "稍后再问",
    });
    expect(localStorage.getItem(assistantSessionStorageKey)).not.toBeNull();
    expect(readAssistantConversations(9_999)).toEqual(migrated);
  });

  it("keeps the legacy session readable when either migration write fails", () => {
    const legacy = session("迁移不能丢失");
    writeAssistantSession({ ...legacy, draft: "旧草稿" }, 1_000);
    const originalSetItem = Storage.prototype.setItem;
    const snapshotKey = assistantConversationStorageKey("conversation-legacy");
    const snapshotFailure = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === snapshotKey) throw new DOMException("quota", "QuotaExceededError");
        return originalSetItem.call(this, key, value);
      });

    const withoutSnapshot = readAssistantConversations(1_001);
    expect(withoutSnapshot.activeId).toBe("conversation-legacy");
    expect(readAssistantConversation("conversation-legacy", 1_002)?.session.draft).toBe(
      "旧草稿",
    );
    expect(localStorage.getItem(assistantConversationsStorageKey)).toBeNull();
    snapshotFailure.mockRestore();

    localStorage.clear();
    writeAssistantSession({ ...legacy, draft: "索引失败也保留" }, 2_000);
    const indexFailure = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === assistantConversationsStorageKey) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });

    const withoutIndex = readAssistantConversations(2_001);
    expect(withoutIndex.activeId).toBe("conversation-legacy");
    expect(readAssistantConversation("conversation-legacy", 2_002)?.session.draft).toBe(
      "索引失败也保留",
    );
    expect(localStorage.getItem(assistantConversationsStorageKey)).toBeNull();
    indexFailure.mockRestore();
  });

  it("reports failed saves and does not publish a half-created conversation", () => {
    const initial = readAssistantConversations(10);
    const currentId = initial.activeId as string;
    const originalSetItem = Storage.prototype.setItem;
    const snapshotFailure = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === assistantConversationStorageKey(currentId)) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });

    expect(
      saveAssistantConversation({ id: currentId, session: session("无法保存") }, 20),
    ).toMatchObject({ state: initial, snapshotSaved: false, indexSaved: false });
    snapshotFailure.mockRestore();

    const indexFailure = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === assistantConversationsStorageKey) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });
    const created = tryCreateAssistantConversation({ id: "conversation-not-published", now: 30 });
    expect(created).toMatchObject({ state: initial, createdId: null, persisted: false });
    expect(localStorage.getItem(assistantConversationStorageKey("conversation-not-published"))).toBeNull();
    indexFailure.mockRestore();
  });

  it("keeps the persisted active id when an active-index update fails", () => {
    const initial = readAssistantConversations(10);
    const firstId = initial.activeId as string;
    const withSecond = createAssistantConversation({ id: "conversation-second", now: 20 });
    expect(withSecond.activeId).toBe("conversation-second");

    const originalSetItem = Storage.prototype.setItem;
    const indexFailure = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === assistantConversationsStorageKey) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });
    try {
      expect(trySetActiveAssistantConversation(firstId, 30)).toMatchObject({
        state: { activeId: "conversation-second" },
        persisted: false,
      });
      expect(readAssistantConversations(31).activeId).toBe("conversation-second");
    } finally {
      indexFailure.mockRestore();
    }
  });

  it("stores each snapshot separately and upserts the captured id without changing active", () => {
    const initial = readAssistantConversations(10);
    const firstId = initial.activeId as string;
    upsertAssistantConversation({ id: firstId, session: session("第一问") }, 20);
    createAssistantConversation({ id: "conversation-second", session: session("第二问"), now: 30 });
    setActiveAssistantConversation("conversation-second", 31);

    const updated = upsertAssistantConversation(
      { id: firstId, session: session("第一问的后续", "旧会话的新回答") },
      40,
    );

    expect(updated.activeId).toBe("conversation-second");
    expect(updated.conversations.map(({ id }) => id)).toEqual([
      firstId,
      "conversation-second",
    ]);
    expect(readAssistantConversation(firstId, 41)?.session.turns[0].answer).toBe(
      "旧会话的新回答",
    );
    expect(readAssistantConversation("conversation-second", 41)?.session.turns[0].question).toBe(
      "第二问",
    );
    expect(localStorage.getItem(assistantConversationStorageKey(firstId))).not.toBeNull();
    expect(localStorage.getItem(assistantConversationStorageKey("conversation-second"))).not.toBeNull();
    expect(localStorage.getItem(assistantConversationsStorageKey)).not.toContain("旧会话的新回答");
  });

  it("expires both awaiting and interrupted action payloads when a snapshot is restored", () => {
    const state = readAssistantConversations(100);
    const id = state.activeId as string;
    upsertAssistantConversation(
      {
        id,
        session: {
          turns: [
            {
              id: "awaiting",
              question: "打开第一讲",
              answer: "请确认",
              actions: [{ kind: "open_video", video_id: "video-1", title: "第一讲" }],
              tools: [],
              canceled: false,
              actionResults: [],
            },
            {
              id: "executing",
              question: "删除第二讲",
              answer: "正在删除",
              actions: [{ kind: "propose_delete", video_id: "video-2", title: "第二讲" }],
              executingActionIndexes: [0],
              tools: [],
              canceled: false,
              actionResults: [],
            },
          ],
          history: [
            { role: "user", content: "处理课程" },
            { role: "assistant", content: "正在处理" },
          ],
          draft: "",
        },
      },
      110,
    );

    const restored = readAssistantConversation(id, 111)?.session;
    expect(restored?.turns.map((turn) => turn.actions)).toEqual([[], []]);
    expect(restored?.turns.map((turn) => turn.checkpoint?.expiredReason)).toEqual([
      "restart",
      "interrupted",
    ]);
    expect(JSON.stringify(restored)).not.toContain("video-1");
    expect(JSON.stringify(restored)).not.toContain("video-2");
  });

  it("sorts by updatedAt, caps count and title/answer text, and removes evicted snapshots", () => {
    const initial = readAssistantConversations(1);
    const evictedId = initial.activeId as string;
    for (let index = 0; index <= MAX_ASSISTANT_CONVERSATIONS; index += 1) {
      createAssistantConversation({
        id: `conversation-${index}`,
        title: "标题".repeat(MAX_ASSISTANT_CONVERSATION_TITLE_CHARS),
        session: session(`问题 ${index}`, "答".repeat(MAX_ASSISTANT_ANSWER_CHARS + 50)),
        now: index + 10,
      });
    }

    const state = readAssistantConversations(1_000);
    expect(state.conversations).toHaveLength(MAX_ASSISTANT_CONVERSATIONS);
    expect(state.conversations[0].id).toBe(`conversation-${MAX_ASSISTANT_CONVERSATIONS}`);
    expect(state.conversations.every((item) => item.title.length <= MAX_ASSISTANT_CONVERSATION_TITLE_CHARS)).toBe(true);
    expect(localStorage.getItem(assistantConversationStorageKey(evictedId))).toBeNull();
    expect(readAssistantConversation(state.conversations[0].id)?.session.turns[0].answer).toHaveLength(
      MAX_ASSISTANT_ANSWER_CHARS,
    );
  });

  it("renames and deletes metadata without resurrecting the legacy session", () => {
    const initial = readAssistantConversations(1);
    const firstId = initial.activeId as string;
    createAssistantConversation({ id: "conversation-two", now: 2 });

    const renamed = renameAssistantConversation(firstId, "  自定义\n标题  ", 3);
    expect(renamed.conversations[0]).toMatchObject({ id: firstId, title: "自定义 标题" });
    expect(renamed.activeId).toBe("conversation-two");

    const afterActiveDelete = deleteAssistantConversation("conversation-two", 4);
    expect(afterActiveDelete.activeId).toBe(firstId);
    const empty = deleteAssistantConversation(firstId, 5);
    expect(empty).toEqual({ activeId: null, conversations: [] });
    expect(readAssistantConversations(6)).toEqual(empty);
  });

  it("recovers safely from corrupt index and snapshot JSON", () => {
    localStorage.setItem(assistantSessionStorageKey, "not-json");
    localStorage.setItem(assistantConversationsStorageKey, "also-not-json");
    const recovered = readAssistantConversations(100);
    expect(recovered.conversations).toHaveLength(1);

    const id = recovered.activeId as string;
    localStorage.setItem(assistantConversationStorageKey(id), "broken-snapshot");
    expect(readAssistantConversation(id, 101)?.session).toEqual({
      turns: [],
      history: [],
      draft: "",
    });
  });
});

describe("recent assistant questions", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a global oldest-to-newest bounded history for ArrowUp/ArrowDown navigation", () => {
    for (let index = 0; index <= MAX_ASSISTANT_PROMPT_HISTORY; index += 1) {
      appendRecentAssistantQuestion(`问题 ${index}`);
    }
    const history = readRecentAssistantQuestions();
    expect(history).toHaveLength(MAX_ASSISTANT_PROMPT_HISTORY);
    expect(history[0]).toBe("问题 1");
    expect(history[history.length - 1]).toBe(`问题 ${MAX_ASSISTANT_PROMPT_HISTORY}`);
  });

  it("caps question text, ignores blanks, and handles corrupt JSON", () => {
    expect(writeRecentAssistantQuestions(["  第一问  ", 123, " ", "问".repeat(20_000)])).toEqual([
      "第一问",
      "问".repeat(MAX_ASSISTANT_PROMPT_CHARS),
    ]);
    localStorage.setItem(assistantRecentQuestionsStorageKey, "broken");
    expect(readRecentAssistantQuestions()).toEqual([]);
    expect(appendRecentAssistantQuestion("  恢复提问  ")).toEqual(["恢复提问"]);
  });
});

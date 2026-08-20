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
  tryDeleteAssistantConversation,
  tryRenameAssistantConversation,
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

function localStorageBytes() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => key !== null)
    .sort()
    .map((key) => [key, localStorage.getItem(key)] as const);
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

  it.each([
    ["corrupt", "{not-json"],
    [
      "unsupported",
      JSON.stringify({
        version: 2,
        activeId: "conversation-existing",
        conversations: [
          { id: "conversation-existing", title: "未来会话", updatedAt: 900 },
        ],
        futureMetadata: { keep: true },
      }),
    ],
  ])("keeps a %s index and every snapshot byte-for-byte read-only", (_label, indexBytes) => {
    const existingId = "conversation-existing";
    const snapshotBytes = '{"turns":[],"history":[],"draft":"","future":"keep"}';
    writeAssistantSession(session("旧固定会话不能被迁移"), 800);
    localStorage.setItem(assistantConversationStorageKey(existingId), snapshotBytes);
    localStorage.setItem(assistantConversationsStorageKey, indexBytes);
    const before = localStorageBytes();

    expect(readAssistantConversations(1_000)).toEqual({ activeId: null, conversations: [] });
    expect(readAssistantConversation(existingId, 1_001)).toBeNull();
    expect(
      tryCreateAssistantConversation({
        id: "conversation-new",
        session: session("不能新增"),
        now: 1_002,
      }),
    ).toEqual({
      state: { activeId: null, conversations: [] },
      createdId: null,
      persisted: false,
      status: "storage_error",
    });
    expect(
      saveAssistantConversation({ id: existingId, session: session("不能覆盖") }, 1_003),
    ).toEqual({
      state: { activeId: null, conversations: [] },
      snapshotSaved: false,
      indexSaved: false,
    });
    expect(trySetActiveAssistantConversation(existingId, 1_004)).toEqual({
      state: { activeId: null, conversations: [] },
      persisted: false,
    });
    expect(renameAssistantConversation(existingId, "不能重命名", 1_005)).toEqual({
      activeId: null,
      conversations: [],
    });
    expect(deleteAssistantConversation(existingId, 1_006)).toEqual({
      activeId: null,
      conversations: [],
    });
    expect(localStorageBytes()).toEqual(before);
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
    expect(created).toMatchObject({
      state: initial,
      createdId: null,
      persisted: false,
      status: "storage_error",
    });
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

  it("refuses the twenty-first non-empty conversation without deleting old snapshots", () => {
    const initial = readAssistantConversations(1);
    const firstId = initial.activeId as string;
    upsertAssistantConversation({ id: firstId, session: session("问题 0") }, 10);
    for (let index = 1; index < MAX_ASSISTANT_CONVERSATIONS; index += 1) {
      const created = tryCreateAssistantConversation({
        id: `conversation-${index}`,
        title: "标题".repeat(MAX_ASSISTANT_CONVERSATION_TITLE_CHARS),
        session: session(`问题 ${index}`, "答".repeat(MAX_ASSISTANT_ANSWER_CHARS + 50)),
        now: index + 10,
      });
      expect(created.status).toBe("created");
    }

    const before = readAssistantConversations(1_000);
    const snapshots = new Map(
      before.conversations.map(({ id }) => [
        id,
        localStorage.getItem(assistantConversationStorageKey(id)),
      ]),
    );
    const blocked = tryCreateAssistantConversation({
      id: "conversation-over-limit",
      session: session("绝不能挤掉旧会话"),
      now: 2_000,
    });

    expect(blocked).toEqual({
      state: before,
      createdId: null,
      persisted: false,
      status: "limit",
    });
    expect(readAssistantConversations(2_001)).toEqual(before);
    expect(localStorage.getItem(assistantConversationStorageKey("conversation-over-limit"))).toBeNull();
    for (const [id, snapshot] of snapshots) {
      expect(localStorage.getItem(assistantConversationStorageKey(id))).toBe(snapshot);
    }
    expect(before.conversations.every((item) => item.title.length <= MAX_ASSISTANT_CONVERSATION_TITLE_CHARS)).toBe(true);
    expect(readAssistantConversation(before.conversations[0].id)?.session.turns[0].answer).toHaveLength(
      MAX_ASSISTANT_ANSWER_CHARS,
    );
  });

  it("reuses an existing empty conversation before allocating another slot", () => {
    const initial = readAssistantConversations(1);
    const firstId = initial.activeId as string;
    upsertAssistantConversation({ id: firstId, session: session("保留的会话") }, 2);
    const empty = tryCreateAssistantConversation({ id: "conversation-empty", now: 3 });
    expect(empty.status).toBe("created");

    const reused = tryCreateAssistantConversation({ now: 4 });
    expect(reused).toMatchObject({
      createdId: "conversation-empty",
      persisted: true,
      status: "reused",
    });
    expect(reused.state.conversations).toHaveLength(2);
    expect(reused.state.activeId).toBe("conversation-empty");
    expect(readAssistantConversation(firstId)?.session.turns[0].question).toBe("保留的会话");
  });

  it("creates a new id instead of overwriting a reusable empty snapshot with supplied content", () => {
    const initial = readAssistantConversations(1);
    const emptyId = initial.activeId as string;
    const emptySnapshot = localStorage.getItem(assistantConversationStorageKey(emptyId));

    const created = tryCreateAssistantConversation({ session: session("新会话内容"), now: 2 });

    expect(created.status).toBe("created");
    expect(created.createdId).not.toBe(emptyId);
    expect(created.state.conversations).toHaveLength(2);
    expect(localStorage.getItem(assistantConversationStorageKey(emptyId))).toBe(emptySnapshot);
    expect(readAssistantConversation(emptyId)?.session).toEqual({
      turns: [],
      history: [],
      draft: "",
    });
    expect(readAssistantConversation(created.createdId as string)?.session.turns[0].question).toBe(
      "新会话内容",
    );
  });

  it("reclaims an empty slot at the limit but preserves every non-empty conversation", () => {
    const initial = readAssistantConversations(1);
    const emptyId = initial.activeId as string;
    for (let index = 1; index < MAX_ASSISTANT_CONVERSATIONS; index += 1) {
      createAssistantConversation({
        id: `conversation-${index}`,
        session: session(`问题 ${index}`),
        now: index + 1,
      });
    }

    const nonEmptyIds = readAssistantConversations().conversations
      .map(({ id }) => id)
      .filter((id) => id !== emptyId);
    const created = tryCreateAssistantConversation({
      id: "conversation-replacement",
      session: session("替换空槽"),
      now: 100,
    });

    expect(created.status).toBe("created");
    expect(created.state.conversations).toHaveLength(MAX_ASSISTANT_CONVERSATIONS);
    expect(created.state.conversations.some(({ id }) => id === emptyId)).toBe(false);
    expect(localStorage.getItem(assistantConversationStorageKey(emptyId))).toBeNull();
    for (const id of nonEmptyIds) {
      expect(readAssistantConversation(id)?.session.turns).not.toHaveLength(0);
    }
  });

  it("rolls back a reused empty snapshot when the index cannot be saved", () => {
    const initial = readAssistantConversations(1);
    const emptyId = initial.activeId as string;
    createAssistantConversation({
      id: "conversation-non-empty",
      session: session("保留的会话"),
      now: 2,
    });
    const emptySnapshot = localStorage.getItem(assistantConversationStorageKey(emptyId));
    const before = readAssistantConversations(3);
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
      expect(tryCreateAssistantConversation({ now: 4 })).toEqual({
        state: before,
        createdId: null,
        persisted: false,
        status: "storage_error",
      });
      expect(localStorage.getItem(assistantConversationStorageKey(emptyId))).toBe(emptySnapshot);
      expect(readAssistantConversations(5)).toEqual(before);
    } finally {
      indexFailure.mockRestore();
    }
  });

  it("preserves an empty snapshot byte-for-byte when copy-on-write index saving fails", () => {
    const initial = readAssistantConversations(1);
    const emptyId = initial.activeId as string;
    const emptySnapshot = localStorage.getItem(assistantConversationStorageKey(emptyId));
    const before = localStorageBytes();
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
      expect(
        tryCreateAssistantConversation({ session: session("不会覆盖空快照"), now: 2 }),
      ).toEqual({
        state: initial,
        createdId: null,
        persisted: false,
        status: "storage_error",
      });
      expect(localStorage.getItem(assistantConversationStorageKey(emptyId))).toBe(emptySnapshot);
      expect(localStorageBytes()).toEqual(before);
    } finally {
      indexFailure.mockRestore();
    }
  });

  it.each([
    ["corrupt", "broken"],
    ["future format", JSON.stringify({ turns: [], history: [], draft: "", futureData: "keep" })],
    ["whitespace draft", JSON.stringify({ turns: [], history: [], draft: " " })],
  ])("does not recycle a %s snapshot", (_label, snapshot) => {
    const initial = readAssistantConversations(1);
    const candidateId = initial.activeId as string;
    localStorage.setItem(assistantConversationStorageKey(candidateId), snapshot);
    for (let index = 1; index < MAX_ASSISTANT_CONVERSATIONS; index += 1) {
      createAssistantConversation({
        id: `conversation-${index}`,
        session: session(`问题 ${index}`),
        now: index + 1,
      });
    }

    expect(tryCreateAssistantConversation({ now: 100 }).status).toBe("limit");
    expect(localStorage.getItem(assistantConversationStorageKey(candidateId))).toBe(snapshot);
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
    const replacement = deleteAssistantConversation(firstId, 5);
    expect(replacement.activeId).not.toBe(firstId);
    expect(replacement.conversations).toEqual([
      expect.objectContaining({ id: replacement.activeId, title: "" }),
    ]);
    expect(readAssistantConversation(replacement.activeId as string)?.session).toEqual({
      turns: [],
      history: [],
      draft: "",
    });
    expect(readAssistantConversations(6)).toEqual(replacement);
  });

  it("does not publish rename or delete when the index cannot be saved", () => {
    const initial = readAssistantConversations(1);
    const firstId = initial.activeId as string;
    createAssistantConversation({ id: "conversation-two", session: session("第二条"), now: 2 });
    const before = readAssistantConversations(3);
    const beforeBytes = localStorageBytes();
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
      expect(tryRenameAssistantConversation(firstId, "不会发布", 4)).toEqual({
        state: before,
        persisted: false,
      });
      expect(tryDeleteAssistantConversation("conversation-two", 5)).toEqual({
        state: before,
        persisted: false,
      });
      expect(localStorageBytes()).toEqual(beforeBytes);
    } finally {
      indexFailure.mockRestore();
    }
  });

  it("keeps the last conversation intact when replacement index publishing fails", () => {
    const before = readAssistantConversations(1);
    const id = before.activeId as string;
    const beforeBytes = localStorageBytes();
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
      expect(tryDeleteAssistantConversation(id, 2)).toEqual({
        state: before,
        persisted: false,
      });
      expect(localStorageBytes()).toEqual(beforeBytes);
      expect(readAssistantConversation(id)?.session).not.toBeNull();
    } finally {
      indexFailure.mockRestore();
    }
  });

  it("reads a corrupt snapshot as empty without changing its bytes", () => {
    const state = readAssistantConversations(100);
    const id = state.activeId as string;
    localStorage.setItem(assistantConversationStorageKey(id), "broken-snapshot");
    expect(readAssistantConversation(id, 101)?.session).toEqual({
      turns: [],
      history: [],
      draft: "",
    });
    expect(localStorage.getItem(assistantConversationStorageKey(id))).toBe("broken-snapshot");
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

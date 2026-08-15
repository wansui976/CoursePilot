import {
  boundAssistantPromptHistory,
  deserializeAssistantSession,
  readAssistantSession,
  serializeAssistantSession,
  type AssistantSession,
} from "./assistantSession";

const INDEX_STORAGE_KEY = "course-ai-assistant-conversations:v1";
const SESSION_STORAGE_KEY_PREFIX = "course-ai-assistant-conversation:v1:";
const RECENT_QUESTIONS_STORAGE_KEY = "course-ai-assistant-recent-questions:v1";
const INDEX_VERSION = 1 as const;
const LEGACY_CONVERSATION_ID = "conversation-legacy";

export const MAX_ASSISTANT_CONVERSATIONS = 20;
export const MAX_ASSISTANT_CONVERSATION_TITLE_CHARS = 80;

export interface AssistantConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface AssistantConversationsState {
  activeId: string | null;
  /** 新近更新的会话排在前面。 */
  conversations: AssistantConversationSummary[];
}

export interface AssistantConversation extends AssistantConversationSummary {
  session: AssistantSession;
}

export interface CreateAssistantConversationOptions {
  id?: string;
  title?: string;
  session?: AssistantSession;
  now?: number;
}

export interface UpsertAssistantConversationInput {
  /** 异步保存必须传捕获时的会话 id，不能在落盘时再读取 activeId。 */
  id: string;
  session: AssistantSession;
  title?: string;
  updatedAt?: number;
}

export interface SaveAssistantConversationResult {
  state: AssistantConversationsState;
  /** 会话正文已经写入独立快照；切换前只需要依赖这一项。 */
  snapshotSaved: boolean;
  /** 标题、排序和 activeId 索引也已经同步。 */
  indexSaved: boolean;
}

export interface CreateAssistantConversationResult {
  state: AssistantConversationsState;
  createdId: string | null;
  persisted: boolean;
  status: "created" | "reused" | "limit" | "storage_error";
}

export interface SetActiveAssistantConversationResult {
  state: AssistantConversationsState;
  persisted: boolean;
}

interface PersistedConversationIndex {
  version: typeof INDEX_VERSION;
  activeId: string | null;
  conversations: AssistantConversationSummary[];
}

const EMPTY_SESSION: AssistantSession = { turns: [], history: [], draft: "" };
const volatileConversationSessions = new Map<string, AssistantSession>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function normalizeTimestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function normalizeTitle(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_ASSISTANT_CONVERSATION_TITLE_CHARS);
}

export function deriveAssistantConversationTitle(session: AssistantSession) {
  const question = session.turns.find((turn) => turn.question.trim())?.question ?? "";
  return normalizeTitle(question);
}

function readSummary(value: unknown): AssistantConversationSummary | null {
  if (!isRecord(value) || !isConversationId(value.id)) return null;
  return {
    id: value.id,
    title: normalizeTitle(value.title),
    updatedAt: normalizeTimestamp(value.updatedAt, 0),
  };
}

function sortConversations(conversations: AssistantConversationSummary[]) {
  const seen = new Set<string>();
  return conversations
    .filter((conversation) => {
      if (seen.has(conversation.id)) return false;
      seen.add(conversation.id);
      return true;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}

function parseIndex(serialized: string | null): AssistantConversationsState | null {
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || value.version !== INDEX_VERSION || !Array.isArray(value.conversations)) {
      return null;
    }
    const conversations = sortConversations(
      value.conversations
        .map(readSummary)
        .filter((conversation) => conversation !== null),
    );
    const activeId =
      isConversationId(value.activeId) &&
      conversations.some((conversation) => conversation.id === value.activeId)
        ? value.activeId
        : (conversations[0]?.id ?? null);
    return { activeId, conversations };
  } catch {
    return null;
  }
}

function serializeIndex(state: AssistantConversationsState) {
  const value: PersistedConversationIndex = {
    version: INDEX_VERSION,
    activeId: state.activeId,
    conversations: state.conversations,
  };
  return JSON.stringify(value);
}

function persistIndex(state: AssistantConversationsState) {
  try {
    localStorage.setItem(INDEX_STORAGE_KEY, serializeIndex(state));
    return true;
  } catch {
    return false;
  }
}

function generateConversationId(now: number, reserved: Set<string>) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const random =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const id = `conversation-${random}`;
    if (!reserved.has(id)) return id;
  }
  return `conversation-${now.toString(36)}-${reserved.size.toString(36)}`;
}

export function assistantConversationStorageKey(id: string) {
  if (!isConversationId(id)) throw new Error("Invalid assistant conversation id");
  return `${SESSION_STORAGE_KEY_PREFIX}${id}`;
}

function persistConversationSnapshot(id: string, session: AssistantSession, now: number) {
  try {
    localStorage.setItem(assistantConversationStorageKey(id), serializeAssistantSession(session, now));
    return true;
  } catch {
    return false;
  }
}

interface ReadConversationSessionResult {
  session: AssistantSession;
  recyclable: boolean;
}

function readConversationSession(id: string, now: number): ReadConversationSessionResult {
  const volatile = volatileConversationSessions.get(id);
  if (volatile) return { session: volatile, recyclable: isEmptySession(volatile) };
  try {
    const serialized = localStorage.getItem(assistantConversationStorageKey(id));
    if (serialized === null) return { session: EMPTY_SESSION, recyclable: false };
    const value = JSON.parse(serialized) as unknown;
    // 只有本模块写出的完整快照才能被判定为空。损坏或旧格式的数据宁可保留，
    // 也不能为了腾位置把仍可能包含用户内容的会话当成空白回收。
    if (
      !isRecord(value) ||
      !Array.isArray(value.turns) ||
      !Array.isArray(value.history) ||
      typeof value.draft !== "string"
    ) {
      return { session: EMPTY_SESSION, recyclable: false };
    }
    const knownKeys = new Set(["turns", "history", "draft", "promptHistory"]);
    const hasUnknownFields = Object.keys(value).some((key) => !knownKeys.has(key));
    const promptHistoryIsEmpty =
      value.promptHistory === undefined ||
      (Array.isArray(value.promptHistory) && value.promptHistory.length === 0);
    return {
      session: deserializeAssistantSession(serialized, now),
      recyclable:
        value.turns.length === 0 &&
        value.history.length === 0 &&
        value.draft.length === 0 &&
        promptHistoryIsEmpty &&
        !hasUnknownFields,
    };
  } catch {
    return { session: EMPTY_SESSION, recyclable: false };
  }
}

function isEmptySession(session: AssistantSession) {
  return (
    session.turns.length === 0 &&
    session.history.length === 0 &&
    session.draft.length === 0 &&
    (session.promptHistory?.length ?? 0) === 0
  );
}

function findReusableEmptyConversation(
  state: AssistantConversationsState,
  now: number,
): AssistantConversation | null {
  for (const summary of state.conversations) {
    if (summary.title) continue;
    const { session, recyclable } = readConversationSession(summary.id, now);
    if (recyclable && isEmptySession(session)) return { ...summary, session };
  }
  return null;
}

function removeConversationSnapshot(id: string) {
  try {
    localStorage.removeItem(assistantConversationStorageKey(id));
  } catch {
    // 会话索引仍然可用；孤立快照以后不会再被读取。
  }
}

function migrateLegacyAssistantSession(now: number): AssistantConversationsState {
  const session = readAssistantSession(now);
  const id = LEGACY_CONVERSATION_ID;
  const state: AssistantConversationsState = {
    activeId: id,
    conversations: [
      {
        id,
        title: deriveAssistantConversationTitle(session),
        updatedAt: now,
      },
    ],
  };
  // 迁移按“快照 -> 索引”提交。若 WebView 存储暂时不可写，保留内存回退，
  // 后续读取仍能拿到旧固定 key 的内容，不能因为半次迁移显示成空会话。
  volatileConversationSessions.set(id, session);
  if (persistConversationSnapshot(id, session, now) && persistIndex(state)) {
    volatileConversationSessions.delete(id);
  }
  return state;
}

export function readAssistantConversations(now = Date.now()): AssistantConversationsState {
  try {
    return parseIndex(localStorage.getItem(INDEX_STORAGE_KEY)) ?? migrateLegacyAssistantSession(now);
  } catch {
    return migrateLegacyAssistantSession(now);
  }
}

export function readAssistantConversation(
  id: string,
  now = Date.now(),
): AssistantConversation | null {
  if (!isConversationId(id)) return null;
  const state = readAssistantConversations(now);
  const summary = state.conversations.find((conversation) => conversation.id === id);
  if (!summary) return null;
  return { ...summary, session: readConversationSession(id, now).session };
}

export function saveAssistantConversation(
  input: UpsertAssistantConversationInput,
  now = Date.now(),
): SaveAssistantConversationResult {
  if (!isConversationId(input.id)) throw new Error("Invalid assistant conversation id");
  const current = readAssistantConversations(now);
  const previous = current.conversations.find((conversation) => conversation.id === input.id);
  if (!persistConversationSnapshot(input.id, input.session, now)) {
    return { state: current, snapshotSaved: false, indexSaved: false };
  }
  volatileConversationSessions.delete(input.id);

  const updatedAt = normalizeTimestamp(input.updatedAt, now);
  const title =
    input.title === undefined
      ? previous?.title || deriveAssistantConversationTitle(input.session)
      : normalizeTitle(input.title);
  const conversations = sortConversations([
    { id: input.id, title, updatedAt },
    ...current.conversations.filter((conversation) => conversation.id !== input.id),
  ]);
  const next: AssistantConversationsState = {
    activeId:
      current.activeId && conversations.some((conversation) => conversation.id === current.activeId)
        ? current.activeId
        : (conversations[0]?.id ?? null),
    conversations,
  };
  const indexSaved = persistIndex(next);
  return {
    state: indexSaved ? next : current,
    snapshotSaved: true,
    indexSaved,
  };
}

export function upsertAssistantConversation(
  input: UpsertAssistantConversationInput,
  now = Date.now(),
): AssistantConversationsState {
  return saveAssistantConversation(input, now).state;
}

export function tryCreateAssistantConversation(
  options: CreateAssistantConversationOptions = {},
): CreateAssistantConversationResult {
  const now = options.now ?? Date.now();
  const current = readAssistantConversations(now);
  const reserved = new Set(current.conversations.map((conversation) => conversation.id));
  if (options.id !== undefined && (!isConversationId(options.id) || reserved.has(options.id))) {
    throw new Error("Assistant conversation id must be unique and storage-safe");
  }
  const session = options.session ?? EMPTY_SESSION;
  const reusable = findReusableEmptyConversation(current, now);
  const reuseExistingId = options.id === undefined && reusable !== null;

  if (current.conversations.length >= MAX_ASSISTANT_CONVERSATIONS && !reusable) {
    return { state: current, createdId: null, persisted: false, status: "limit" };
  }

  const id = reuseExistingId
    ? reusable.id
    : (options.id ?? generateConversationId(now, reserved));
  const reclaimedId =
    current.conversations.length >= MAX_ASSISTANT_CONVERSATIONS && !reuseExistingId
      ? reusable?.id ?? null
      : null;
  if (!persistConversationSnapshot(id, session, now)) {
    return {
      state: current,
      createdId: null,
      persisted: false,
      status: "storage_error",
    };
  }
  volatileConversationSessions.delete(id);

  // 系统时间回拨时也要保证新建或复用的会话排在最前面。
  const updatedAt = Math.max(now, (current.conversations[0]?.updatedAt ?? -1) + 1);
  const conversations = sortConversations([
    {
      id,
      title: options.title === undefined
        ? deriveAssistantConversationTitle(session)
        : normalizeTitle(options.title),
      updatedAt,
    },
    ...current.conversations.filter(
      (conversation) => conversation.id !== id && conversation.id !== reclaimedId,
    ),
  ]);
  const next = { activeId: id, conversations };
  if (!persistIndex(next)) {
    if (reuseExistingId && reusable) {
      persistConversationSnapshot(reusable.id, reusable.session, now);
    } else {
      removeConversationSnapshot(id);
    }
    return {
      state: current,
      createdId: null,
      persisted: false,
      status: "storage_error",
    };
  }
  if (reclaimedId) {
    removeConversationSnapshot(reclaimedId);
    volatileConversationSessions.delete(reclaimedId);
  }
  return {
    state: next,
    createdId: id,
    persisted: true,
    status: reuseExistingId ? "reused" : "created",
  };
}

export function createAssistantConversation(
  options: CreateAssistantConversationOptions = {},
): AssistantConversationsState {
  return tryCreateAssistantConversation(options).state;
}

export function trySetActiveAssistantConversation(
  id: string,
  now = Date.now(),
): SetActiveAssistantConversationResult {
  const current = readAssistantConversations(now);
  if (!current.conversations.some((conversation) => conversation.id === id)) {
    return { state: current, persisted: false };
  }
  const next = { ...current, activeId: id };
  const persisted = persistIndex(next);
  return { state: persisted ? next : current, persisted };
}

export function setActiveAssistantConversation(
  id: string,
  now = Date.now(),
): AssistantConversationsState {
  return trySetActiveAssistantConversation(id, now).state;
}

export function renameAssistantConversation(
  id: string,
  title: string,
  now = Date.now(),
): AssistantConversationsState {
  const current = readAssistantConversations(now);
  const normalized = normalizeTitle(title);
  if (!normalized || !current.conversations.some((conversation) => conversation.id === id)) {
    return current;
  }
  const next = {
    activeId: current.activeId,
    conversations: sortConversations(
      current.conversations.map((conversation) =>
        conversation.id === id
          ? { ...conversation, title: normalized, updatedAt: now }
          : conversation,
      ),
    ),
  };
  persistIndex(next);
  return next;
}

export function deleteAssistantConversation(
  id: string,
  now = Date.now(),
): AssistantConversationsState {
  const current = readAssistantConversations(now);
  if (!current.conversations.some((conversation) => conversation.id === id)) return current;
  const conversations = current.conversations.filter((conversation) => conversation.id !== id);
  const next = {
    activeId: current.activeId === id ? (conversations[0]?.id ?? null) : current.activeId,
    conversations,
  };
  if (persistIndex(next)) removeConversationSnapshot(id);
  volatileConversationSessions.delete(id);
  return next;
}

export function readRecentAssistantQuestions(): string[] {
  try {
    const serialized = localStorage.getItem(RECENT_QUESTIONS_STORAGE_KEY);
    if (!serialized) return [];
    const value = JSON.parse(serialized) as unknown;
    return Array.isArray(value) ? boundAssistantPromptHistory(value) : [];
  } catch {
    return [];
  }
}

export function writeRecentAssistantQuestions(questions: unknown[]): string[] {
  const bounded = boundAssistantPromptHistory(questions);
  try {
    localStorage.setItem(RECENT_QUESTIONS_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // 输入历史不可用时不影响发送。
  }
  return bounded;
}

export function appendRecentAssistantQuestion(question: string): string[] {
  const normalized = boundAssistantPromptHistory([question]);
  if (normalized.length === 0) return readRecentAssistantQuestions();
  return writeRecentAssistantQuestions([...readRecentAssistantQuestions(), normalized[0]]);
}

export const assistantConversationsStorageKey = INDEX_STORAGE_KEY;
export const assistantRecentQuestionsStorageKey = RECENT_QUESTIONS_STORAGE_KEY;

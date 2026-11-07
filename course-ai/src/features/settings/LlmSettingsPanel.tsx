import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, Eye, EyeOff, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { ipc } from "@/lib/ipc";
import { LLM_PRESETS, presetFor } from "@/lib/llmPresets";
import type { LlmProfile, ModelInfo, ModelList, ProviderKind } from "@/lib/types";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

const FIELD =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)]";

const PROTOCOLS: ProviderKind[] = ["openai", "anthropic", "gemini", "ollama", "azure_openai"];

// 当前默认模型用 routing 实现：把所有任务都路由到选中的 profile。
const ROUTING_TASKS = [
  "notes",
  "chapters",
  "summary",
  "quiz",
  "mindmap",
  "rag",
  // 字幕纠错。原来它不走路由，而是「拿列表里第一个有 Key 的」，
  // 于是这里选的模型对它不生效——字幕可能被发去另一家、算在另一个账上。
  "correction",
  "digest",
  // 全局助手。它要判断意图、调工具，挂便宜模型会经常听不懂，所以跟着默认模型走。
  "assistant",
] as const;

// 「当前默认模型」会把所有任务重写成同一个 profile。digest（长视频的分块提要）是例外：
// 它只是压缩，值得单独挂一个便宜模型，而那份手工配置不该在改任何模型设置时被静默盖掉。
const TASKS_KEEPING_MANUAL_ROUTING = ["digest"] as const;

interface LlmDraft {
  profiles: LlmProfile[];
  keys: Record<string, string>;
  activeId: string | null;
  manualRouting: Record<string, string>;
}

/** 一个 profile 的模型列表 / 拉取状态。获取模型不算「未保存修改」。 */
interface ModelState {
  models: ModelInfo[];
  fetchedAt?: number;
  cached?: boolean;
  note?: string;
  error?: string;
  loading?: boolean;
}

export interface LlmSettingsActions {
  save: () => Promise<boolean>;
  discard: () => void;
}

interface LlmSettingsPanelProps {
  onDirtyChange?: (dirty: boolean) => void;
  onRegisterActions?: (actions: LlmSettingsActions | null) => void;
}

function makeDraft(
  profiles: LlmProfile[],
  keys: Record<string, string>,
  activeId: string | null,
  manualRouting: Record<string, string>,
): LlmDraft {
  return {
    profiles: profiles.map((profile) => ({ ...profile })),
    keys: Object.fromEntries(
      Object.entries(keys).filter(([, value]) => value !== ""),
    ),
    activeId,
    manualRouting: { ...manualRouting },
  };
}

function draftSignature(draft: LlmDraft): string {
  return JSON.stringify(draft);
}

function requiresKey(profile: LlmProfile): boolean {
  // Ollama 的 Provider 没有鉴权通道，key_required 对它只能是摆设。
  if (profile.kind === "ollama") return false;
  return profile.key_required ?? true;
}

/** 是否会向同一个地址、按同一种协议发请求；与后端 `models::same_connection` 对齐。 */
function sameConnection(a: LlmProfile, b: LlmProfile): boolean {
  const url = (value: string) => value.trim().replace(/\/+$/, "");
  const opt = (value?: string | null) => (value ?? "").trim();
  return (
    a.kind === b.kind &&
    url(a.base_url) === url(b.base_url) &&
    opt(a.api_version) === opt(b.api_version) &&
    opt(a.deployment) === opt(b.deployment) &&
    opt(a.models_path) === opt(b.models_path)
  );
}

function formatTokens(value?: number | null): string | null {
  if (value == null || value <= 0) return null;
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatPrice(value?: number | null): string | null {
  if (value == null) return null;
  if (value === 0) return "$0";
  const decimals = value >= 0.1 ? 2 : 3;
  return `$${value.toFixed(decimals)}`;
}

function agoLabel(t: (key: string, options?: Record<string, unknown>) => string, at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return t("llmSettings.meta.justNow");
  if (minutes < 60) return t("llmSettings.meta.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("llmSettings.meta.hoursAgo", { count: hours });
  return t("llmSettings.meta.daysAgo", { count: Math.floor(hours / 24) });
}

const SOURCE_LABEL_KEYS: Record<string, string> = {
  provider: "llmSettings.meta.sourceProvider",
  catalog: "llmSettings.meta.sourceCatalog",
  "provider+catalog": "llmSettings.meta.sourceMixed",
  unknown: "llmSettings.meta.sourceUnknown",
};

export function LlmSettingsPanel({
  onDirtyChange,
  onRegisterActions,
}: LlmSettingsPanelProps = {}) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  // 手工配过的任务路由（目前只有 digest）。保存时要原样带回去，不能被「当前默认模型」冲掉。
  const [manualRouting, setManualRouting] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");
  // 加载完成前 profiles 还是空的。没有这个闸门，用户在这一小段时间（或加载失败后）
  // 点保存，就会用空列表覆盖掉磁盘上的全部配置与 Key。
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [savedMsg, setSavedMsg] = useState("");
  const [savedIsError, setSavedIsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [presetKey, setPresetKey] = useState("custom");
  const [modelState, setModelState] = useState<Record<string, ModelState>>({});
  // 本机 Ollama 检测结果：null = 没检测到（或还没检测完）。
  const [localOllama, setLocalOllama] = useState<string[] | null>(null);
  const savedDraftRef = useRef<LlmDraft | null>(null);
  const currentDraft = useMemo(
    () => makeDraft(profiles, keys, activeId, manualRouting),
    [activeId, keys, manualRouting, profiles],
  );
  const dirty =
    savedDraftRef.current !== null &&
    draftSignature(currentDraft) !== draftSignature(savedDraftRef.current);
  const saveActionRef = useRef<() => Promise<boolean>>(async () => false);
  const discardActionRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!onRegisterActions) return;
    onRegisterActions({
      save: () => saveActionRef.current(),
      discard: () => discardActionRef.current(),
    });
    return () => onRegisterActions(null);
  }, [onRegisterActions]);

  useEffect(() => {
    let cancelled = false;
    // 重新加载期间先收回编辑权：profiles 还是旧值/空值时保存，等于把磁盘上的配置
    // 按眼前这份半成品覆盖掉。
    savedDraftRef.current = null;
    setLoading(true);
    setLoadError("");
    setKeys({});
    setHasKey({});
    setShowKey({});
    setModelState({});
    setSavedMsg("");
    setSavedIsError(false);
    void (async () => {
      try {
        const ps = await ipc.ai.getProfiles();
        // 当前默认模型：从已存 routing 推断（任一任务指向的 profile），否则第一个。
        let active: string | null = ps[0]?.id ?? null;
        const routingRaw = await ipc.settings.get("llm_task_routing");
        const manual: Record<string, string> = {};
        if (routingRaw) {
          try {
            const routing = JSON.parse(routingRaw) as Record<string, string | null>;
            // 「当前默认模型」取任一任务指向的 profile；digest 可能被单独指到别处，
            // 所以推断默认模型时把它排除，否则会把便宜模型当成默认模型显示。
            const hit = ROUTING_TASKS.filter(
              (task) => !TASKS_KEEPING_MANUAL_ROUTING.includes(task as "digest"),
            )
              .map((task) => routing[task])
              .find((value) => value && ps.some((p) => p.id === value));
            if (hit) active = hit;
            for (const task of TASKS_KEEPING_MANUAL_ROUTING) {
              const value = routing[task];
              if (value && ps.some((p) => p.id === value)) manual[task] = value;
            }
          } catch {
            // routing JSON 损坏时忽略，用第一个；IPC 读取错误则交给外层显示。
          }
        }
        if (cancelled) return;
        // 先把配置放出来、结束加载态，再查 Key。`hasApiKey` 在部分平台可能很慢
        // （钥匙串/凭证管理器），不能让它挡住编辑与保存。加载完成后配置已经完整，
        // 此时保存是安全的；标志位晚一点补上只影响输入框显示「已配置」。
        setProfiles(ps);
        setActiveId(active);
        setManualRouting(manual);
        savedDraftRef.current = makeDraft(ps, {}, active, manual);
        setLoading(false);

        const flags: Record<string, boolean> = {};
        await Promise.all(
          ps.map(async (p) => {
            flags[p.id] = await ipc.ai.hasApiKey(p.id).catch(() => false);
          }),
        );
        if (!cancelled) setHasKey(flags);
      } catch (error) {
        if (cancelled) return;
        setProfiles([]);
        setActiveId(null);
        setManualRouting({});
        savedDraftRef.current = null;
        setLoading(false);
        setLoadError(t("llmSettings.loadError", { error: String(error) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken, t]);

  function update(id: string, patch: Partial<LlmProfile>) {
    clearSaveFeedback();
    // 地址 / 协议 / 版本 / 部署名变了，之前拉到的模型清单就不算数了。
    if (
      ["kind", "base_url", "api_version", "models_path", "deployment"].some(
        (field) => field in patch,
      )
    ) {
      setModelState((state) => {
        if (!state[id]) return state;
        const next = { ...state };
        delete next[id];
        return next;
      });
    }
    setProfiles((ps) =>
      ps.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p, ...patch };
        // Ollama 没有鉴权通道，别把“必须填 Key”留在配置里。
        if (next.kind === "ollama") next.key_required = null;
        return next;
      }),
    );
  }

  // 打开设置时顺手看一眼本机有没有 Ollama 在跑。很多人已经用 Ollama 拉好了模型，
  // 却不知道这里能直接接上；检测到了就给一个一键添加，省得自己去查地址、填模型名。
  useEffect(() => {
    let cancelled = false;
    void ipc.ai
      .detectOllama()
      .then((models) => {
        if (!cancelled) setLocalOllama(models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function addLocalOllama(models: string[]) {
    clearSaveFeedback();
    const preset = presetFor("ollama");
    const id = uid();
    // 嵌入模型（nomic-embed-text 之类）不能聊天，默认挑第一个不是嵌入的。
    const chat = models.find((name) => !/embed/i.test(name)) ?? models[0] ?? preset.model;
    const profile: LlmProfile = {
      id,
      name: t("llmSettings.localOllamaName"),
      kind: "ollama",
      base_url: preset.base_url,
      model: chat,
      key_required: false,
    };
    setProfiles((ps) => [...ps, profile]);
    setActiveId((current) => current ?? id);
    void fetchModels(profile, false);
  }

  function add() {
    clearSaveFeedback();
    const preset = presetFor(presetKey);
    const id = uid();
    const profile: LlmProfile = {
      id,
      name: preset.custom ? t("llmSettings.newProfile") : preset.name,
      kind: preset.kind,
      base_url: preset.base_url,
      model: preset.model,
      ...(preset.api_version ? { api_version: preset.api_version } : {}),
      ...(preset.keyRequired === false ? { key_required: false } : {}),
    };
    setProfiles((ps) => [...ps, profile]);
    setActiveId((current) => current ?? id);
  }

  async function fetchModels(profile: LlmProfile, refresh: boolean) {
    const id = profile.id;
    setModelState((state) => ({
      ...state,
      [id]: { ...(state[id] ?? { models: [] }), loading: true, error: undefined },
    }));
    try {
      const list: ModelList = await ipc.ai.listModels(profile, keys[id] ?? null, refresh);
      setModelState((state) => ({
        ...state,
        [id]: {
          models: list.models,
          fetchedAt: list.fetched_at,
          cached: list.cached,
          note: list.note ?? undefined,
          loading: false,
        },
      }));
      // 模型名还空着就顺手填第一个，省得用户再点一次。
      if (!profile.model.trim() && list.models[0]) {
        update(id, { model: list.models[0].id });
      }
    } catch (error) {
      setModelState((state) => ({
        ...state,
        [id]: {
          ...(state[id] ?? { models: [] }),
          loading: false,
          error: String(error),
        },
      }));
    }
  }

  // 删除已保存的配置是破坏性操作（保存后连同 Key 路由一起消失）：先确认。
  async function remove(profile: LlmProfile) {
    const ok = await confirmDialog(t("llmSettings.deleteConfirm", { name: profile.name }), {
      title: t("llmSettings.deleteTitle"),
      kind: "warning",
      okLabel: t("llmSettings.deleteLabel"),
      cancelLabel: t("llmSettings.cancel"),
    });
    if (!ok) return;
    clearSaveFeedback();
    const remaining = profiles.filter((p) => p.id !== profile.id);
    setProfiles(remaining);
    // 删掉的正好是当前默认：把默认交给剩下的第一个，别留下 activeId=null
    // 而界面又把第一个显示成默认的分裂状态（保存时会把路由写成空）。
    setActiveId((current) =>
      current === profile.id ? (remaining[0]?.id ?? null) : current,
    );
    // 草稿里刚输入的 Key 跟着配置一起丢掉。否则保存时会把一把属于已删配置的
    // Key 写进钥匙串，永远没人再引用它。
    setKeys((current) => {
      if (!(profile.id in current)) return current;
      const next = { ...current };
      delete next[profile.id];
      return next;
    });
    setShowKey((current) => {
      const next = { ...current };
      delete next[profile.id];
      return next;
    });
    setModelState((current) => {
      const next = { ...current };
      delete next[profile.id];
      return next;
    });
  }

  function clearSaveFeedback() {
    setSavedMsg("");
    setSavedIsError(false);
  }

  function discard() {
    const saved = savedDraftRef.current;
    if (!saved) return;
    setProfiles(saved.profiles.map((profile) => ({ ...profile })));
    setKeys({ ...saved.keys });
    setActiveId(saved.activeId);
    setManualRouting({ ...saved.manualRouting });
    clearSaveFeedback();
  }

  function validationError(draft: LlmDraft): string | null {
    for (const profile of draft.profiles) {
      const name = profile.name.trim() || t("llmSettings.unnamed");
      if (!profile.name.trim()) return t("llmSettings.validationName");
      if (!profile.model.trim()) {
        return t("llmSettings.validationModel", { name });
      }
      // 其余协议留空会落到各自官方地址；OpenAI 兼容 / Azure 没有可靠默认值，
      // 空着要等到真正请求时才报一句「relative URL without a base」。
      if (
        (profile.kind === "openai" || profile.kind === "azure_openai") &&
        !profile.base_url.trim()
      ) {
        return t("llmSettings.validationBaseUrl", { name });
      }
      if (
        profile.max_output_tokens != null &&
        (!Number.isFinite(profile.max_output_tokens) ||
          profile.max_output_tokens < 1 ||
          profile.max_output_tokens > 1_000_000)
      ) {
        return t("llmSettings.validationMaxOutput", { name });
      }
      // 已存 Key 只属于旧地址：改了连接信息又没重新输入 Key，后端会拒绝保存。
      // 在前端先说清楚，省得用户点了保存才看到一条错误。
      const saved = savedDraftRef.current?.profiles.find((p) => p.id === profile.id);
      if (
        saved &&
        profile.kind !== "ollama" &&
        !sameConnection(saved, profile) &&
        hasKey[profile.id] &&
        !draft.keys[profile.id]
      ) {
        return t("llmSettings.validationKeyAfterChange", { name });
      }
    }
    return null;
  }

  async function save(): Promise<boolean> {
    // 加载中/加载失败时 profiles 不是磁盘上的真实状态，保存只会把它覆盖掉。
    if (loading || loadError || !savedDraftRef.current) return false;

    const draftToSave = makeDraft(profiles, keys, activeId, manualRouting);
    const problem = validationError(draftToSave);
    if (problem) {
      setSavedMsg(problem);
      setSavedIsError(true);
      return false;
    }

    // 当前默认：activeId 失效（例如刚删掉它）时和界面显示保持一致，用第一个。
    const active =
      (draftToSave.activeId &&
      draftToSave.profiles.some((p) => p.id === draftToSave.activeId)
        ? draftToSave.activeId
        : draftToSave.profiles[0]?.id) ?? null;
    const routing: Record<string, string> = {};
    if (active) {
      for (const task of ROUTING_TASKS) routing[task] = active;
    }
    // 手工 digest 路由必须在 `if (active)` 外面恢复：删掉当前默认配置后 active 为 null，
    // 但它不该跟着被清掉。
    for (const task of TASKS_KEEPING_MANUAL_ROUTING) {
      const manual = draftToSave.manualRouting[task];
      if (manual && draftToSave.profiles.some((p) => p.id === manual)) {
        routing[task] = manual;
      }
    }
    // 只保存仍属于现存配置的 Key：删掉刚填过 Key 的新配置后，草稿里可能还留着它。
    const keysToSave = Object.fromEntries(
      Object.entries(draftToSave.keys).filter(([id]) =>
        draftToSave.profiles.some((p) => p.id === id),
      ),
    );

    setSaving(true);
    try {
      // 一次 IPC 提交配置与 Key：后端先写 Key 再落库，Key 失败时配置不会先保存。
      await ipc.ai.saveProfiles(
        JSON.stringify(draftToSave.profiles),
        JSON.stringify(routing),
        keysToSave,
      );
      setActiveId(active);
      setHasKey((flags) => {
        const next = { ...flags };
        for (const id of Object.keys(keysToSave)) next[id] = true;
        return next;
      });
      // 只清掉本次实际保存的 Key；若保存途中又输入了新值，它仍作为未保存草稿保留。
      setKeys((current) => {
        const next = { ...current };
        for (const [id, key] of Object.entries(keysToSave)) {
          if (next[id] === key) delete next[id];
        }
        return next;
      });
      savedDraftRef.current = makeDraft(
        draftToSave.profiles,
        {},
        active,
        draftToSave.manualRouting,
      );
      setSavedMsg(t("llmSettings.saved"));
      setSavedIsError(false);
      return true;
    } catch (error) {
      // 保存失败要说出来：否则界面上的配置和库里的从此各说各话。
      setSavedMsg(t("llmSettings.saveFailed", { error: String(error) }));
      setSavedIsError(true);
      return false;
    } finally {
      setSaving(false);
    }
  }

  saveActionRef.current = save;
  discardActionRef.current = discard;

  const effectiveActive =
    activeId && profiles.some((p) => p.id === activeId) ? activeId : profiles[0]?.id ?? null;

  function renderModelMeta(profile: LlmProfile) {
    const state = modelState[profile.id];
    if (!state) return null;
    const info = state.models.find((model) => model.id === profile.model.trim());
    const badges = [
      info?.capabilities.tools ? t("llmSettings.meta.tools") : null,
      info?.capabilities.vision ? t("llmSettings.meta.vision") : null,
      info?.capabilities.json ? t("llmSettings.meta.json") : null,
      info?.capabilities.reasoning ? t("llmSettings.meta.reasoning") : null,
    ].filter(Boolean) as string[];
    return (
      <div className="mt-1 space-y-1 text-xs text-[var(--text-muted)]">
        {info && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {formatTokens(info.context_window) && (
              <span>{t("llmSettings.meta.context", { value: formatTokens(info.context_window) })}</span>
            )}
            {(info.input_price != null || info.output_price != null) && (
              <span>
                {t("llmSettings.meta.price", {
                  input: formatPrice(info.input_price) ?? "—",
                  output: formatPrice(info.output_price) ?? "—",
                })}
              </span>
            )}
            {badges.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {badges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded bg-[var(--surface-card)] px-1.5 py-0.5 text-[var(--text-normal)]"
                  >
                    {badge}
                  </span>
                ))}
              </span>
            )}
            {info.source === "unknown" && <span>{t("llmSettings.meta.unknown")}</span>}
          </div>
        )}
        {state.fetchedAt != null && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{t(SOURCE_LABEL_KEYS[state.models.find((m) => m.id === profile.model.trim())?.source ?? "unknown"] ?? "llmSettings.meta.sourceUnknown")}</span>
            <span>·</span>
            <span>{t("llmSettings.meta.fetched", { when: agoLabel(t, state.fetchedAt) })}</span>
            {state.cached && <span>· {t("llmSettings.meta.cached")}</span>}
          </div>
        )}
        {state.note && <p className="leading-relaxed">{state.note}</p>}
        {state.error && (
          <p role="alert" className="text-[var(--status-err)]">
            {t("llmSettings.fetchFailed", { error: state.error })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={t("llmSettings.preset")}
          value={presetKey}
          onChange={(event) => setPresetKey(event.target.value)}
          className="max-w-56 flex-1"
        >
          {LLM_PRESETS.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.custom ? t("llmSettings.customPreset") : preset.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={add}
          disabled={loading || Boolean(loadError) || saving}
          data-tour="llm-add"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("llmSettings.add")}
        </Button>
      </div>
      {!loading &&
        !loadError &&
        localOllama &&
        !profiles.some((profile) => profile.kind === "ollama") && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-xs text-[var(--text-normal)]"
        >
          <span className="min-w-0 flex-1 leading-relaxed">
            {localOllama.length > 0
              ? t("llmSettings.localOllamaFound", { count: localOllama.length })
              : t("llmSettings.localOllamaNoModels")}
          </span>
          {localOllama.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => addLocalOllama(localOllama)}>
              <Plus className="h-3.5 w-3.5" />
              {t("llmSettings.localOllamaAdd")}
            </Button>
          )}
        </div>
      )}
      {loading && (
        <p role="status" className="py-2 text-xs leading-relaxed text-[var(--text-muted)]">
          {t("llmSettings.loading")}
        </p>
      )}
      {loadError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--status-err)] bg-[var(--status-err-bg)] px-3 py-2 text-xs text-[var(--status-err)]"
        >
          <span className="min-w-0 flex-1">{loadError}</span>
          <Button size="sm" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
            {t("llmSettings.retry")}
          </Button>
        </div>
      )}
      {!loading && !loadError && profiles.length === 0 && (
        <p className="py-2 text-xs leading-relaxed text-[var(--text-muted)]">
          {t("llmSettings.emptyHint")}
        </p>
      )}
      {!loading &&
        profiles.map((p) => {
          const isActive = effectiveActive === p.id;
          const state = modelState[p.id];
          const models = state?.models ?? [];
          const needsKey = requiresKey(p);
          return (
          <div
            key={p.id}
            className={`space-y-2 rounded-xl border bg-[var(--surface-input)] p-3 transition ${
              isActive
                ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                : "border-[var(--border-subtle)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  clearSaveFeedback();
                  setActiveId(p.id);
                }}
                aria-pressed={isActive}
                title={isActive ? t("llmSettings.activeModel") : t("llmSettings.setDefault")}
                className={`flex flex-none items-center gap-1.5 rounded-full px-2 py-1 text-xs transition ${
                  isActive
                    ? "bg-[var(--accent-weak)] text-[var(--accent-text)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
                }`}
              >
                <span
                  className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${
                    isActive
                      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                      : "border-[var(--text-faint)]"
                  }`}
                >
                  {isActive && <Check className="h-2.5 w-2.5" />}
                </span>
                {isActive ? t("llmSettings.active") : t("llmSettings.setAsDefault")}
              </button>
              <input
                aria-label={t("llmSettings.profileName")}
                className={`${FIELD} flex-1`}
                value={p.name}
                placeholder={t("llmSettings.profileNamePlaceholder")}
                onChange={(e) => update(p.id, { name: e.target.value })}
              />
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">
                {t("llmSettings.protocol")}
              </span>
              <Select
                aria-label={t("llmSettings.protocol")}
                value={p.kind}
                onChange={(e) => update(p.id, { kind: e.target.value as ProviderKind })}
              >
                {PROTOCOLS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`llmSettings.protocols.${kind}`)}
                  </option>
                ))}
              </Select>
            </label>

            <input
              aria-label="Base URL"
              className={FIELD}
              value={p.base_url}
              placeholder="Base URL"
              onChange={(e) => update(p.id, { base_url: e.target.value })}
            />
            {p.kind === "azure_openai" && (
              <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                {t("llmSettings.baseUrlHintAzure")}
              </p>
            )}
            {!needsKey && (
              <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                {t("llmSettings.baseUrlHintOllama")}
              </p>
            )}

            <div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    aria-label={t("llmSettings.modelName")}
                    className={FIELD}
                    value={p.model}
                    list={`llm-models-${p.id}`}
                    placeholder={t("llmSettings.modelPlaceholder")}
                    onChange={(e) => update(p.id, { model: e.target.value })}
                  />
                  <datalist id={`llm-models-${p.id}`}>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {formatTokens(model.context_window) ?? model.id}
                      </option>
                    ))}
                  </datalist>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-none gap-1.5"
                  disabled={state?.loading}
                  onClick={() => void fetchModels(p, Boolean(state?.fetchedAt))}
                >
                  {state?.loading ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : state?.fetchedAt ? (
                    <RefreshCw className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {state?.loading
                    ? t("llmSettings.fetchingModels")
                    : state?.fetchedAt
                      ? t("llmSettings.refreshModels")
                      : t("llmSettings.fetchModels")}
                </Button>
              </div>
              {renderModelMeta(p)}
            </div>

            {needsKey ? (
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    aria-label="API Key"
                    type={showKey[p.id] ? "text" : "password"}
                    className={`${FIELD} pr-10`}
                    value={keys[p.id] ?? ""}
                    placeholder={hasKey[p.id] ? "••••••" : "API Key"}
                    onChange={(e) => {
                      clearSaveFeedback();
                      setKeys((k) => ({ ...k, [p.id]: e.target.value }));
                    }}
                  />
                  <button
                    type="button"
                    aria-label={showKey[p.id] ? t("llmSettings.hideKey") : t("llmSettings.showKey")}
                    title={showKey[p.id] ? t("llmSettings.hideLabel") : t("llmSettings.showLabel")}
                    onClick={() => setShowKey((s) => ({ ...s, [p.id]: !s[p.id] }))}
                    className="ca-touch-44 ca-workbench-touch absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                  >
                    {showKey[p.id] ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
                {hasKey[p.id] && !keys[p.id] && (
                  <span className="inline-flex flex-none items-center gap-1 rounded-full bg-[var(--status-ok-bg)] px-2 py-1 text-xs font-medium text-[var(--status-ok)]">
                    <Check className="h-3 w-3" />
                    {t("llmSettings.configured")}
                  </span>
                )}
              </div>
            ) : null}

            <details className="group rounded-lg border border-[var(--border-faint)] px-3 py-1.5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs text-[var(--text-muted)] [&::-webkit-details-marker]:hidden">
                <span>{t("llmSettings.advanced")}</span>
                <ChevronDown
                  aria-hidden="true"
                  className="h-3.5 w-3.5 flex-none transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {p.kind === "azure_openai" && (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-xs text-[var(--text-muted)]">
                        {t("llmSettings.apiVersion")}
                      </span>
                      <input
                        aria-label={t("llmSettings.apiVersion")}
                        className={FIELD}
                        value={p.api_version ?? ""}
                        placeholder="2024-10-21"
                        onChange={(e) => update(p.id, { api_version: e.target.value || null })}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-[var(--text-muted)]">
                        {t("llmSettings.deployment")}
                      </span>
                      <input
                        aria-label={t("llmSettings.deployment")}
                        className={FIELD}
                        value={p.deployment ?? ""}
                        placeholder={p.model}
                        onChange={(e) => update(p.id, { deployment: e.target.value || null })}
                      />
                    </label>
                  </>
                )}
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--text-muted)]">
                    {t("llmSettings.maxOutput")}
                  </span>
                  <span className="mb-1 block text-[11px] leading-relaxed text-[var(--text-faint)]">
                    {t("llmSettings.maxOutputHint")}
                  </span>
                  <input
                    aria-label={t("llmSettings.maxOutput")}
                    type="number"
                    min={1}
                    className={FIELD}
                    value={p.max_output_tokens ?? ""}
                    placeholder="8192"
                    onChange={(e) =>
                      update(p.id, {
                        max_output_tokens: e.target.value
                          ? Math.max(1, Math.floor(Number(e.target.value)))
                          : null,
                      })
                    }
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs text-[var(--text-muted)]">
                    {t("llmSettings.modelsPath")}
                  </span>
                  <span className="mb-1 block text-[11px] leading-relaxed text-[var(--text-faint)]">
                    {t("llmSettings.modelsPathHint")}
                  </span>
                  <input
                    aria-label={t("llmSettings.modelsPath")}
                    className={FIELD}
                    value={p.models_path ?? ""}
                    placeholder="models"
                    onChange={(e) => update(p.id, { models_path: e.target.value || null })}
                  />
                </label>
                {p.kind !== "ollama" && (
                  <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-normal)] sm:col-span-2">
                    <span>{t("llmSettings.noKeyRequired")}</span>
                    <Switch
                      aria-label={t("llmSettings.noKeyRequired")}
                      checked={!needsKey}
                      onCheckedChange={(next) =>
                        update(p.id, { key_required: next ? false : true })
                      }
                    />
                  </div>
                )}
              </div>
            </details>

            <Button
              className="text-xs text-[var(--text-muted)] transition hover:text-[var(--status-err)]"
              onClick={() => void remove(p)}
            >
              {t("llmSettings.delete")}
            </Button>
          </div>
        );
      })}
      <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-[var(--border-faint)] bg-[var(--surface-card)] py-3">
        {/* 有未保存修改时「保存」升为主操作，否则退成普通按钮，不和「新增」抢注意力。 */}
        <Button
          size="sm"
          variant={dirty ? "primary" : "default"}
          disabled={saving || loading || Boolean(loadError)}
          onClick={() => void save()}
        >
          {saving ? t("llmSettings.saving") : t("llmSettings.save")}
        </Button>
        {(dirty || savedMsg) && (
          <span
            role={savedIsError ? "alert" : "status"}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
              savedIsError
                ? "bg-[var(--status-err-bg)] text-[var(--status-err)]"
                : dirty
                  ? "bg-[var(--status-warn-bg)] text-[var(--status-warn)]"
                  : "bg-[var(--status-ok-bg)] text-[var(--status-ok)]"
            }`}
          >
            {savedMsg || t("llmSettings.unsaved")}
          </span>
        )}
      </div>
    </div>
  );
}

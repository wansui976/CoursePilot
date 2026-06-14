import { useEffect, useState } from "react";
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { LlmProfile, ProviderKind } from "@/lib/types";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

const DEFAULT_BASE: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

const FIELD =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)]";

// 当前默认模型用 routing 实现：把所有任务都路由到选中的 profile。
const ROUTING_TASKS = [
  "notes",
  "chapters",
  "summary",
  "quiz",
  "mindmap",
  "rag",
  "vision_ocr",
] as const;

export function LlmSettingsPanel() {
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    void (async () => {
      const ps = await ipc.ai.getProfiles();
      setProfiles(ps);
      // 当前默认模型：从已存 routing 推断（任一任务指向的 profile），否则第一个。
      let active: string | null = ps[0]?.id ?? null;
      try {
        const routingRaw = await ipc.settings.get("llm_task_routing");
        if (routingRaw) {
          const routing = JSON.parse(routingRaw) as Record<string, string | null>;
          const hit = ROUTING_TASKS.map((task) => routing[task]).find(
            (value) => value && ps.some((p) => p.id === value),
          );
          if (hit) active = hit;
        }
      } catch {
        // routing 损坏时忽略，用第一个。
      }
      setActiveId(active);
      // 标记哪些配置已存有 API Key → 输入框显示掩码。
      const flags: Record<string, boolean> = {};
      await Promise.all(
        ps.map(async (p) => {
          flags[p.id] = await ipc.ai.hasApiKey(p.id).catch(() => false);
        }),
      );
      setHasKey(flags);
    })();
  }, []);

  function update(id: string, patch: Partial<LlmProfile>) {
    setProfiles((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function add() {
    const id = uid();
    setProfiles((ps) => [
      ...ps,
      { id, name: "新配置", kind: "openai", base_url: DEFAULT_BASE.openai, model: "gpt-4o-mini" },
    ]);
    setActiveId((current) => current ?? id);
  }

  function remove(id: string) {
    setProfiles((ps) => ps.filter((p) => p.id !== id));
    setActiveId((current) => (current === id ? null : current));
  }

  async function save() {
    const routing: Record<string, string> = {};
    if (activeId && profiles.some((p) => p.id === activeId)) {
      for (const task of ROUTING_TASKS) routing[task] = activeId;
    }
    await ipc.ai.saveProfiles(JSON.stringify(profiles), JSON.stringify(routing));
    for (const [id, key] of Object.entries(keys)) {
      if (key) await ipc.ai.setApiKey(id, key);
    }
    setHasKey((flags) => {
      const next = { ...flags };
      for (const [id, key] of Object.entries(keys)) if (key) next[id] = true;
      return next;
    });
    setKeys({});
    setSavedMsg("已保存");
    setTimeout(() => setSavedMsg(""), 1500);
  }

  const effectiveActive =
    activeId && profiles.some((p) => p.id === activeId) ? activeId : profiles[0]?.id ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          配置多个模型，选一个作为「当前使用」
        </p>
        <Button size="sm" variant="outline" onClick={add}>
          新增
        </Button>
      </div>
      {profiles.length === 0 && (
        <p className="rounded-lg border border-dashed border-[var(--border-subtle)] px-3 py-4 text-center text-xs text-[var(--text-faint)]">
          还没有配置。点「新增」添加一个 OpenAI 兼容或 Anthropic 配置。
        </p>
      )}
      {profiles.map((p) => {
        const isActive = effectiveActive === p.id;
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
                onClick={() => setActiveId(p.id)}
                aria-pressed={isActive}
                title={isActive ? "当前使用的模型" : "设为当前使用"}
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
                {isActive ? "使用中" : "设为默认"}
              </button>
              <input
                className={`${FIELD} flex-1`}
                value={p.name}
                placeholder="名称"
                onChange={(e) => update(p.id, { name: e.target.value })}
              />
              <div className="relative">
                <select
                  className={`${FIELD} w-auto cursor-pointer appearance-none pr-9`}
                  value={p.kind}
                  onChange={(e) => {
                    const kind = e.target.value as ProviderKind;
                    update(p.id, { kind, base_url: DEFAULT_BASE[kind] });
                  }}
                >
                  <option value="openai">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              </div>
            </div>
            <input
              className={FIELD}
              value={p.base_url}
              placeholder="Base URL"
              onChange={(e) => update(p.id, { base_url: e.target.value })}
            />
            <input
              className={FIELD}
              value={p.model}
              placeholder="模型名（如 gpt-4o / claude-sonnet-4-6）"
              onChange={(e) => update(p.id, { model: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey[p.id] ? "text" : "password"}
                  className={`${FIELD} pr-10`}
                  value={keys[p.id] ?? ""}
                  placeholder={
                    hasKey[p.id] ? "已配置 ••••••（留空＝不修改）" : "API Key"
                  }
                  onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
                />
                <button
                  type="button"
                  aria-label={showKey[p.id] ? "隐藏 API Key" : "显示 API Key"}
                  title={showKey[p.id] ? "隐藏" : "显示"}
                  onClick={() => setShowKey((s) => ({ ...s, [p.id]: !s[p.id] }))}
                  className="ca-touch-44 absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                >
                  {showKey[p.id] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {hasKey[p.id] && !keys[p.id] && (
                <span className="inline-flex flex-none items-center gap-1 rounded-full bg-[var(--status-ok-bg)] px-2 py-1 text-xs font-medium text-[var(--status-ok)]">
                  <Check className="h-3 w-3" />
                  已配置
                </span>
              )}
            </div>
            <button
              className="text-xs text-[var(--text-muted)] transition hover:text-[var(--status-err)]"
              onClick={() => remove(p.id)}
            >
              删除此配置
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save}>
          保存 LLM 配置
        </Button>
        {savedMsg && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-ok-bg)] px-2 py-0.5 text-xs font-medium text-[var(--status-ok)]">
            {savedMsg}
          </span>
        )}
      </div>
    </div>
  );
}

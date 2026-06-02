import { useEffect, useState } from "react";
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
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)] focus:border-[var(--accent-text)] focus:ring-2 focus:ring-[var(--accent-text)]/25";

export function LlmSettingsPanel() {
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    void ipc.ai.getProfiles().then(setProfiles);
  }, []);

  function update(id: string, patch: Partial<LlmProfile>) {
    setProfiles((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function add() {
    setProfiles((ps) => [
      ...ps,
      {
        id: uid(),
        name: "新配置",
        kind: "openai",
        base_url: DEFAULT_BASE.openai,
        model: "gpt-4o-mini",
      },
    ]);
  }

  async function save() {
    // routing 暂留空（用第一个 profile）；后续可扩展每任务选择
    await ipc.ai.saveProfiles(JSON.stringify(profiles), JSON.stringify({}));
    for (const [id, key] of Object.entries(keys)) {
      if (key) await ipc.ai.setApiKey(id, key);
    }
    setKeys({});
    setSavedMsg("已保存");
    setTimeout(() => setSavedMsg(""), 1500);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          可添加多个 OpenAI 兼容或 Anthropic 服务
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
      {profiles.map((p) => (
        <div
          key={p.id}
          className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-input)] p-3"
        >
          <div className="flex gap-2">
            <input
              className={`${FIELD} flex-1`}
              value={p.name}
              placeholder="名称"
              onChange={(e) => update(p.id, { name: e.target.value })}
            />
            <select
              className={`${FIELD} w-auto`}
              value={p.kind}
              onChange={(e) => {
                const kind = e.target.value as ProviderKind;
                update(p.id, { kind, base_url: DEFAULT_BASE[kind] });
              }}
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
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
          <input
            type="password"
            className={FIELD}
            value={keys[p.id] ?? ""}
            placeholder="API Key（留空＝不修改）"
            onChange={(e) =>
              setKeys((k) => ({ ...k, [p.id]: e.target.value }))
            }
          />
          <button
            className="text-xs text-[var(--text-muted)] transition hover:text-red-500"
            onClick={() =>
              setProfiles((ps) => ps.filter((x) => x.id !== p.id))
            }
          >
            删除此配置
          </button>
        </div>
      ))}
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

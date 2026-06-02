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
        <h3 className="text-sm font-medium">LLM 配置</h3>
        <Button size="sm" variant="outline" onClick={add}>
          新增
        </Button>
      </div>
      {profiles.length === 0 && (
        <p className="text-xs text-[var(--text-faint)]">
          还没有配置。点「新增」添加一个 OpenAI 兼容或 Anthropic 配置。
        </p>
      )}
      {profiles.map((p) => (
        <div key={p.id} className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
              value={p.name}
              placeholder="名称"
              onChange={(e) => update(p.id, { name: e.target.value })}
            />
            <select
              className="rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
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
            className="w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
            value={p.base_url}
            placeholder="Base URL"
            onChange={(e) => update(p.id, { base_url: e.target.value })}
          />
          <input
            className="w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
            value={p.model}
            placeholder="模型名（如 gpt-4o / claude-sonnet-4-6）"
            onChange={(e) => update(p.id, { model: e.target.value })}
          />
          <input
            type="password"
            className="w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
            value={keys[p.id] ?? ""}
            placeholder="API Key（留空＝不修改）"
            onChange={(e) =>
              setKeys((k) => ({ ...k, [p.id]: e.target.value }))
            }
          />
          <button
            className="text-xs text-red-500 hover:underline"
            onClick={() =>
              setProfiles((ps) => ps.filter((x) => x.id !== p.id))
            }
          >
            删除此配置
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save}>
          保存 LLM 配置
        </Button>
        {savedMsg && <span className="text-xs text-emerald-500">{savedMsg}</span>}
      </div>
    </div>
  );
}

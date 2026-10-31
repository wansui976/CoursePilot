import type { ProviderKind } from "@/lib/types";

/**
 * 新增配置时的预设。只放「地址 + 协议 + 一个能用的模型名」，用户点「获取模型」
 * 之后可以换成任何自己有权限的模型；模型名只是给一个不空的起点。
 *
 * 价格与上下文不写死在这里：那由后端目录 + 接口返回决定，避免两处数据打架。
 */
export interface LlmPreset {
  key: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  model: string;
  api_version?: string;
  /** false = 该协议不需要 Key（本地 Ollama）。 */
  keyRequired?: boolean;
  custom?: boolean;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    key: "openai",
    name: "OpenAI",
    kind: "openai",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o",
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    kind: "openai",
    base_url: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  {
    key: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
  },
  {
    key: "gemini",
    name: "Google Gemini",
    kind: "gemini",
    base_url: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-pro",
  },
  {
    key: "ollama",
    name: "Ollama",
    kind: "ollama",
    base_url: "http://127.0.0.1:11434",
    model: "llama3.1:8b",
    keyRequired: false,
  },
  {
    key: "azure",
    name: "Azure OpenAI",
    kind: "azure_openai",
    base_url: "https://YOUR-RESOURCE.openai.azure.com",
    model: "gpt-4o",
    api_version: "2024-10-21",
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    base_url: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o",
  },
  {
    key: "moonshot",
    name: "Moonshot Kimi",
    kind: "openai",
    base_url: "https://api.moonshot.cn/v1",
    model: "kimi-k2.5",
  },
  {
    key: "zhipu",
    name: "智谱 GLM",
    kind: "openai",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.6",
  },
  {
    key: "qwen",
    name: "通义千问（百炼）",
    kind: "openai",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-max",
  },
  {
    key: "siliconflow",
    name: "SiliconFlow",
    kind: "openai",
    base_url: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
  },
  {
    key: "custom",
    name: "自定义",
    kind: "openai",
    base_url: "https://api.openai.com/v1",
    model: "",
    custom: true,
  },
];

export function presetFor(key: string): LlmPreset {
  return LLM_PRESETS.find((preset) => preset.key === key) ?? LLM_PRESETS[LLM_PRESETS.length - 1];
}

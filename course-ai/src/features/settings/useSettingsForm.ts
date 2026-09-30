/**
 * 存储 / 语音识别 / 课件三个分类共用的表单模型：一次性读出全部设置，
 * 即时写入按键串行落库，并汇总读写错误给设置页顶部的横幅。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { pickDirectoryPath } from "@/lib/mobileFiles";
import { createSettingsWriter } from "@/lib/settingsWriteQueue";
import {
  AUTO_SENSITIVITY,
  DEFAULT_SLIDES_SENSITIVITY,
  getSlidesSensitivity,
  setSlidesSensitivity,
  type SlidesSensitivity,
} from "@/lib/slides";
import { defaultAsrBackend, normalizeAsrBackend } from "@/lib/asrDefaults";
import { defaultOcrBackend, normalizeOcrBackend } from "@/lib/ocrDefaults";

/** 查询某项凭证「是否已配置」（只回布尔、不回读明文），供密钥字段旁显示「已配置」。
 *  refresh() 在保存成功后调用，把状态刷新为最新。 */
function useSecretConfigured(name: string) {
  const [configured, setConfigured] = useState(false);
  const refresh = useCallback(() => {
    ipc.secrets
      .has(name)
      .then(setConfigured)
      .catch(() => {});
  }, [name]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { configured, refresh };
}

export function useSettingsForm() {
  const { t } = useTranslation();
  const volcSecret = useSecretConfigured("volcengine_asr_access_token");
  const dashSecret = useSecretConfigured("dashscope_api_key");
  const ocrSecret2 = useSecretConfigured("aliyun_ocr_access_key_secret");
  const deepseekSecret = useSecretConfigured("deepseek_ocr_api_key");
  const [root, setRoot] = useState("");
  const [model, setModel] = useState("large-v3-turbo");
  const [asrBackend, setAsrBackend] = useState(defaultAsrBackend());
  const [asrLanguage, setAsrLanguage] = useState("zh");
  const [correctionConcurrency, setCorrectionConcurrency] = useState("8");
  const [subtitleAutocorrect, setSubtitleAutocorrect] = useState(true);
  const [slidesAutoExtract, setSlidesAutoExtract] = useState(true);
  const [volcengineAppId, setVolcengineAppId] = useState("");
  const [volcengineToken, setVolcengineToken] = useState("");
  const [volcengineSaved, setVolcengineSaved] = useState("");
  const [volcengineSavedErr, setVolcengineSavedErr] = useState(false);
  const [volcengineHotwords, setVolcengineHotwords] = useState("");
  const [volcengineContext, setVolcengineContext] = useState("");
  const [volcengineCtxSaved, setVolcengineCtxSaved] = useState("");
  const [volcengineCtxSavedErr, setVolcengineCtxSavedErr] = useState(false);
  const [dashscopeKey, setDashscopeKey] = useState("");
  const [dashscopeSaved, setDashscopeSaved] = useState("");
  const [dashscopeSavedErr, setDashscopeSavedErr] = useState(false);
  const [aliyunModel, setAliyunModel] = useState("qwen3-asr-flash-filetrans");
  const [ocrBackend, setOcrBackend] = useState(defaultOcrBackend());
  const [ocrType, setOcrType] = useState("Advanced");
  const [ocrKeyId, setOcrKeyId] = useState("");
  const [ocrSecret, setOcrSecret] = useState("");
  const [ocrSaved, setOcrSaved] = useState("");
  const [ocrSavedErr, setOcrSavedErr] = useState(false);
  const [deepseekModel, setDeepseekModel] = useState("deepseek-v4-flash-vision-exp");
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState("https://api.deepseek.com");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [deepseekSaved, setDeepseekSaved] = useState("");
  const [deepseekSavedErr, setDeepseekSavedErr] = useState(false);
  const [slidesSensitivity, setSlidesSensitivityState] = useState(() =>
    getSlidesSensitivity(),
  );
  const slidesAuto = slidesSensitivity === AUTO_SENSITIVITY;
  // 关掉「自动」时回到手调档位；滑块本身只在手调模式下可用。
  const slidesSliderValue = slidesAuto ? DEFAULT_SLIDES_SENSITIVITY : slidesSensitivity;
  const changeSlidesSensitivity = (value: SlidesSensitivity) => {
    setSlidesSensitivityState(value);
    setSlidesSensitivity(value);
  };
  // 同一个 key 的即时写入必须按触发顺序落库；否则快速切换时，较慢的旧请求可能最后覆盖新值。
  const settingsWriterRef = useRef<ReturnType<typeof createSettingsWriter> | null>(null);
  if (!settingsWriterRef.current) {
    settingsWriterRef.current = createSettingsWriter(ipc.settings.set);
  }
  const latestSaveByKeyRef = useRef(new Map<string, number>());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const saveError = Object.values(saveErrors)[0] ?? null;
  const saveSetting = useCallback(async (key: string, value: string) => {
    const requestId = (latestSaveByKeyRef.current.get(key) ?? 0) + 1;
    latestSaveByKeyRef.current.set(key, requestId);
    try {
      await settingsWriterRef.current!(key, value);
      if (requestId !== latestSaveByKeyRef.current.get(key)) return;
      setSaveErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (error) {
      if (requestId !== latestSaveByKeyRef.current.get(key)) return;
      setSaveErrors((current) => ({ ...current, [key]: String(error) }));
    }
  }, []);
  // 凭证保存进行中：禁用保存按钮防连点。
  const [savingCred, setSavingCred] = useState<"volc" | "ctx" | "dash" | "ocr" | "deepseek" | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (key: string, apply: (value: string | null) => void) => {
      const value = await ipc.settings.get(key);
      if (!cancelled) apply(value);
    };
    const requests = [
      load("default_storage_root", (value) => setRoot(value ?? "")),
      load("whisper_model", (value) => setModel(value ?? "large-v3-turbo")),
      load("asr_backend", (value) => setAsrBackend(normalizeAsrBackend(value))),
      load("asr_language", (value) => setAsrLanguage(value ?? "zh")),
      load("asr_correction_concurrency", (value) => setCorrectionConcurrency(value ?? "8")),
      load("subtitle_autocorrect", (value) => setSubtitleAutocorrect(value !== "false")),
      load("slides_auto_extract", (value) => setSlidesAutoExtract(value !== "off")),
      load("volcengine_asr_app_id", (value) => setVolcengineAppId(value ?? "")),
      load("volcengine_asr_hotwords", (value) => setVolcengineHotwords(value ?? "")),
      load("volcengine_asr_context", (value) => setVolcengineContext(value ?? "")),
      load("aliyun_asr_model", (value) =>
        setAliyunModel(value ?? "qwen3-asr-flash-filetrans"),
      ),
      load("ocr_backend", (value) => setOcrBackend(normalizeOcrBackend(value))),
      load("aliyun_ocr_type", (value) => setOcrType(value ?? "Advanced")),
      load("aliyun_ocr_access_key_id", (value) => setOcrKeyId(value ?? "")),
      load("deepseek_ocr_model", (value) =>
        setDeepseekModel(value ?? "deepseek-v4-flash-vision-exp"),
      ),
      load("deepseek_ocr_base_url", (value) =>
        setDeepseekBaseUrl(value ?? "https://api.deepseek.com"),
      ),
    ];
    void Promise.allSettled(requests).then((results) => {
      if (cancelled) return;
      const failed = results.find((result) => result.status === "rejected");
      setLoadError(failed?.status === "rejected" ? String(failed.reason) : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function pickRoot() {
    const dir = await pickDirectoryPath(["storage"]);
    if (typeof dir === "string") {
      setRoot(dir);
      await saveSetting("default_storage_root", dir);
    }
  }

  // 「留空 = 跟视频同目录」是文档承诺，必须给清空手段。
  async function clearRoot() {
    setRoot("");
    await saveSetting("default_storage_root", "");
  }

  async function changeModel(value: string) {
    setModel(value);
    await saveSetting("whisper_model", value);
  }

  async function changeAsrBackend(value: string) {
    const next = normalizeAsrBackend(value);
    setAsrBackend(next);
    await saveSetting("asr_backend", next);
  }

  async function changeAsrLanguage(value: string) {
    setAsrLanguage(value);
    await saveSetting("asr_language", value);
  }

  async function changeCorrectionConcurrency(value: string) {
    setCorrectionConcurrency(value);
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1) {
      await saveSetting("asr_correction_concurrency", String(Math.min(2500, Math.floor(n))));
    }
  }

  // 失焦时把非法值（0/空/超限）夹回有效区间并落库，不留「显示 0 实存 8」的脱节。
  async function normalizeCorrectionConcurrency() {
    const n = Number(correctionConcurrency);
    const next = Number.isFinite(n)
      ? String(Math.min(2500, Math.max(1, Math.floor(n))))
      : "8";
    setCorrectionConcurrency(next);
    await saveSetting("asr_correction_concurrency", next);
  }

  async function changeSubtitleAutocorrect(value: boolean) {
    setSubtitleAutocorrect(value);
    await saveSetting("subtitle_autocorrect", value ? "true" : "false");
  }

  async function changeSlidesAutoExtract(value: boolean) {
    setSlidesAutoExtract(value);
    await saveSetting("slides_auto_extract", value ? "on" : "off");
  }

  async function saveVolcengineKey() {
    const appId = volcengineAppId.trim();
    const token = volcengineToken.trim();
    if (!appId && !token) return;
    setVolcengineSaved("");
    setVolcengineSavedErr(false);
    setSavingCred("volc");
    try {
      if (appId) await ipc.settings.set("volcengine_asr_app_id", appId);
      if (token) await ipc.secrets.set("volcengine_asr_access_token", token);
      if (token) {
        volcSecret.refresh();
        setVolcengineToken("");
      }
      setVolcengineSaved(t("settings.saved"));
      setVolcengineSavedErr(false);
    } catch (error) {
      // 不再无声失败：把后端写入错误直接显示出来，便于定位（例如 DB 不可写）。
      setVolcengineSaved(t("settings.saveFailed", { error }));
      setVolcengineSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  async function saveVolcengineContext() {
    setVolcengineCtxSaved("");
    setVolcengineCtxSavedErr(false);
    setSavingCred("ctx");
    try {
      await ipc.settings.set("volcengine_asr_hotwords", volcengineHotwords.trim());
      await ipc.settings.set("volcengine_asr_context", volcengineContext.trim());
      setVolcengineCtxSaved(t("settings.saved"));
      setVolcengineCtxSavedErr(false);
    } catch (error) {
      setVolcengineCtxSaved(t("settings.saveFailed", { error }));
      setVolcengineCtxSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  async function changeAliyunModel(value: string) {
    setAliyunModel(value);
    await saveSetting("aliyun_asr_model", value);
  }

  async function saveDashscopeKey() {
    if (!dashscopeKey.trim()) return;
    setDashscopeSaved("");
    setDashscopeSavedErr(false);
    setSavingCred("dash");
    try {
      await ipc.secrets.set("dashscope_api_key", dashscopeKey.trim());
      dashSecret.refresh();
      setDashscopeKey("");
      setDashscopeSaved(t("settings.saved"));
      setDashscopeSavedErr(false);
    } catch (error) {
      setDashscopeSaved(t("settings.saveFailed", { error }));
      setDashscopeSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  async function changeOcrBackend(value: string) {
    const next = normalizeOcrBackend(value);
    setOcrBackend(next);
    await saveSetting("ocr_backend", next);
  }

  async function changeOcrType(value: string) {
    setOcrType(value);
    await saveSetting("aliyun_ocr_type", value);
  }

  async function saveOcrCreds() {
    const keyId = ocrKeyId.trim();
    const secret = ocrSecret.trim();
    if (!keyId && !secret) return;
    setOcrSaved("");
    setOcrSavedErr(false);
    setSavingCred("ocr");
    try {
      if (keyId) await ipc.settings.set("aliyun_ocr_access_key_id", keyId);
      if (secret) await ipc.secrets.set("aliyun_ocr_access_key_secret", secret);
      if (secret) {
        ocrSecret2.refresh();
        setOcrSecret("");
      }
      setOcrSaved(t("settings.saved"));
      setOcrSavedErr(false);
    } catch (error) {
      setOcrSaved(t("settings.saveFailed", { error }));
      setOcrSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  async function saveDeepseekOcr() {
    const model = deepseekModel.trim();
    const baseUrl = deepseekBaseUrl.trim();
    const key = deepseekKey.trim();
    if (!key && !model && !baseUrl) return;
    setDeepseekSaved("");
    setDeepseekSavedErr(false);
    setSavingCred("deepseek");
    try {
      if (model) await ipc.settings.set("deepseek_ocr_model", model);
      if (baseUrl) await ipc.settings.set("deepseek_ocr_base_url", baseUrl);
      if (key) {
        await ipc.secrets.set("deepseek_ocr_api_key", key);
        deepseekSecret.refresh();
        setDeepseekKey("");
      }
      setDeepseekSaved(t("settings.saved"));
      setDeepseekSavedErr(false);
    } catch (error) {
      setDeepseekSaved(t("settings.saveFailed", { error }));
      setDeepseekSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }


  return {
    root,
    setRoot,
    model,
    setModel,
    asrBackend,
    setAsrBackend,
    asrLanguage,
    setAsrLanguage,
    correctionConcurrency,
    setCorrectionConcurrency,
    subtitleAutocorrect,
    setSubtitleAutocorrect,
    slidesAutoExtract,
    setSlidesAutoExtract,
    volcengineAppId,
    setVolcengineAppId,
    volcengineToken,
    setVolcengineToken,
    volcengineSaved,
    setVolcengineSaved,
    volcengineSavedErr,
    setVolcengineSavedErr,
    volcengineHotwords,
    setVolcengineHotwords,
    volcengineContext,
    setVolcengineContext,
    volcengineCtxSaved,
    setVolcengineCtxSaved,
    volcengineCtxSavedErr,
    setVolcengineCtxSavedErr,
    dashscopeKey,
    setDashscopeKey,
    dashscopeSaved,
    setDashscopeSaved,
    dashscopeSavedErr,
    setDashscopeSavedErr,
    aliyunModel,
    setAliyunModel,
    ocrBackend,
    setOcrBackend,
    ocrType,
    setOcrType,
    ocrKeyId,
    setOcrKeyId,
    ocrSecret,
    setOcrSecret,
    ocrSaved,
    setOcrSaved,
    ocrSavedErr,
    setOcrSavedErr,
    deepseekModel,
    setDeepseekModel,
    deepseekBaseUrl,
    setDeepseekBaseUrl,
    deepseekKey,
    setDeepseekKey,
    deepseekSaved,
    setDeepseekSaved,
    deepseekSavedErr,
    setDeepseekSavedErr,
    slidesSensitivity,
    loadError,
    savingCred,
    setSavingCred,
    volcSecret,
    dashSecret,
    ocrSecret2,
    deepseekSecret,
    slidesAuto,
    slidesSliderValue,
    changeSlidesSensitivity,
    saveError,
    saveSetting,
    pickRoot,
    clearRoot,
    changeModel,
    changeAsrBackend,
    changeAsrLanguage,
    changeCorrectionConcurrency,
    normalizeCorrectionConcurrency,
    changeSubtitleAutocorrect,
    changeSlidesAutoExtract,
    saveVolcengineKey,
    saveVolcengineContext,
    changeAliyunModel,
    saveDashscopeKey,
    changeOcrBackend,
    changeOcrType,
    saveOcrCreds,
    saveDeepseekOcr,
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;

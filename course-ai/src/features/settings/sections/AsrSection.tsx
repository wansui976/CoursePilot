import { useTranslation } from "react-i18next";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { WhisperModelsPanel } from "@/features/settings/WhisperModelsPanel";
import { FIELD, Select, Group, Row, StackRow, SavedBadge } from "@/features/settings/primitives";
import type { SettingsForm } from "@/features/settings/useSettingsForm";
import { isMobile } from "@/lib/platform";

/** 语音识别引擎、凭证与字幕纠错。 */
export function AsrSection({ form }: { form: SettingsForm }) {
  const { t } = useTranslation();
  const {
    model,
    asrBackend,
    asrLanguage,
    correctionConcurrency,
    subtitleAutocorrect,
    volcengineAppId,
    setVolcengineAppId,
    volcengineToken,
    setVolcengineToken,
    volcengineSaved,
    volcengineSavedErr,
    volcengineHotwords,
    setVolcengineHotwords,
    volcengineContext,
    setVolcengineContext,
    volcengineCtxSaved,
    volcengineCtxSavedErr,
    dashscopeKey,
    setDashscopeKey,
    dashscopeSaved,
    dashscopeSavedErr,
    aliyunModel,
    savingCred,
    volcSecret,
    dashSecret,
    changeModel,
    changeAsrBackend,
    changeAsrLanguage,
    changeCorrectionConcurrency,
    normalizeCorrectionConcurrency,
    changeSubtitleAutocorrect,
    saveVolcengineKey,
    saveVolcengineContext,
    changeAliyunModel,
    saveDashscopeKey,
  } = form;
  const mobile = isMobile();

  return (
    <>
      <Group header={t("settings.asr.engineTitle")}>
        <Row label={t("settings.asr.backend")} htmlFor="asr-backend">
          <div className="w-full sm:w-56">
            <Select
              id="asr-backend"
              value={asrBackend}
              onChange={(event) => void changeAsrBackend(event.target.value)}
            >
              {!mobile && <option value="whisper">{t("settings.asr.localWhisper")}</option>}
              <option value="volcengine">{t("settings.asr.volcengine")}</option>
              <option value="aliyun">{t("settings.asr.aliyun")}</option>
            </Select>
          </div>
        </Row>
        <Row
          label={t("settings.asr.language")}
          htmlFor="asr-language"
          hint={
            mobile
              ? t("settings.asr.languageHintMobile")
              : t("settings.asr.languageHintDesktop")
          }
        >
          <div className="w-full sm:w-40">
            <Select
              id="asr-language"
              value={asrLanguage}
              onChange={(event) => void changeAsrLanguage(event.target.value)}
            >
              <option value="auto">{t("settings.asr.autoDetect")}</option>
              <option value="zh">{t("settings.asr.zh")}</option>
              <option value="en">{t("settings.asr.en")}</option>
              <option value="ja">{t("settings.asr.ja")}</option>
              <option value="ko">{t("settings.asr.ko")}</option>
              <option value="yue">{t("settings.asr.yue")}</option>
              <option value="fr">{t("settings.asr.fr")}</option>
              <option value="de">{t("settings.asr.de")}</option>
              <option value="es">{t("settings.asr.es")}</option>
              <option value="ru">{t("settings.asr.ru")}</option>
            </Select>
          </div>
        </Row>
        <Row
          label={t("settings.asr.concurrency")}
          htmlFor="asr-correction-concurrency"
          hint={t("settings.asr.concurrencyHint")}
        >
          <input
            id="asr-correction-concurrency"
            type="number"
            min={1}
            max={2500}
            step={1}
            className={`${FIELD} w-24 text-right`}
            value={correctionConcurrency}
            onChange={(event) =>
              void changeCorrectionConcurrency(event.target.value)
            }
            onBlur={() => void normalizeCorrectionConcurrency()}
          />
        </Row>
        <Row
          label={t("settings.asr.importCorrection")}
          htmlFor="subtitle-autocorrect"
          hint={t("settings.asr.importCorrectionHint")}
        >
          <Switch
            id="subtitle-autocorrect"
            checked={subtitleAutocorrect}
            onCheckedChange={(next) =>
              void changeSubtitleAutocorrect(next)
            }
          />
        </Row>
      </Group>

      {!mobile && asrBackend === "whisper" && (
        <Group header={t("settings.asr.whisperTitle")}>
          <Row label={t("settings.asr.defaultModel")} htmlFor="whisper-model">
            <div className="w-full sm:w-44">
              <Select
                id="whisper-model"
                value={model}
                onChange={(event) => void changeModel(event.target.value)}
              >
                <option value="tiny">tiny</option>
                <option value="base">base</option>
                <option value="small">small</option>
                <option value="medium">medium</option>
                <option value="large-v3-turbo">large-v3-turbo</option>
              </Select>
            </div>
          </Row>
          <StackRow label={t("settings.asr.modelDownload")}>
            <WhisperModelsPanel />
          </StackRow>
        </Group>
      )}

      {asrBackend === "volcengine" && (
        <Group header={t("settings.asr.volcengineTitle")}>
          <Row label="App ID" htmlFor="volcengine-asr-app-id">
            <input
              id="volcengine-asr-app-id"
              type="text"
              className={`${FIELD} w-full sm:w-64`}
              value={volcengineAppId}
              placeholder={t("settings.asr.appIdPlaceholder")}
              onChange={(event) => setVolcengineAppId(event.target.value)}
            />
          </Row>
          <Row
            label="Access Token"
            htmlFor="volcengine-asr-token"
            hint={volcSecret.configured ? t("settings.configured") : t("settings.notConfigured")}
          >
            <input
              id="volcengine-asr-token"
              type="password"
              className={`${FIELD} w-full sm:w-64`}
              value={volcengineToken}
              placeholder="••••••••"
              onChange={(event) => setVolcengineToken(event.target.value)}
            />
          </Row>
          <StackRow>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={savingCred !== null}
                onClick={saveVolcengineKey}
              >
                {t("settings.asr.saveVolcCreds")}
              </Button>
              <SavedBadge text={volcengineSaved} isError={volcengineSavedErr} />
            </div>
          </StackRow>
          <StackRow
            label={t("settings.asr.hotwords")}
            htmlFor="volcengine-asr-hotwords"
            hint={t("settings.asr.hotwordsHint")}
          >
            <textarea
              id="volcengine-asr-hotwords"
              className={`${FIELD} min-h-[72px] resize-y`}
              value={volcengineHotwords}
              placeholder={t("settings.asr.hotwordsPlaceholder")}
              onChange={(event) => setVolcengineHotwords(event.target.value)}
            />
          </StackRow>
          <StackRow
            label={t("settings.asr.context")}
            htmlFor="volcengine-asr-context"
            hint={t("settings.asr.contextHint")}
          >
            <textarea
              id="volcengine-asr-context"
              className={`${FIELD} min-h-[72px] resize-y`}
              value={volcengineContext}
              placeholder={t("settings.asr.contextPlaceholder")}
              onChange={(event) => setVolcengineContext(event.target.value)}
            />
          </StackRow>
          <StackRow>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={savingCred !== null}
                onClick={saveVolcengineContext}
              >
                {t("settings.asr.saveHotwordsContext")}
              </Button>
              <SavedBadge text={volcengineCtxSaved} isError={volcengineCtxSavedErr} />
            </div>
          </StackRow>
        </Group>
      )}

      {asrBackend === "aliyun" && (
        <Group header={t("settings.asr.aliyunTitle")}>
          <Row label={t("settings.asr.aliyunModel")} htmlFor="aliyun-asr-model">
            <div className="w-full sm:w-64">
              <Select
                id="aliyun-asr-model"
                value={aliyunModel}
                onChange={(event) => void changeAliyunModel(event.target.value)}
              >
                <option value="qwen3-asr-flash-filetrans">
                  {t("settings.asr.qwen3AsrFlash")}
                </option>
                <option value="fun-asr">Fun-ASR</option>
                <option value="paraformer-v2">Paraformer-v2</option>
              </Select>
            </div>
          </Row>
          <Row
            label={t("settings.asr.aliyunApiKey")}
            htmlFor="dashscope-key"
            hint={dashSecret.configured ? t("settings.configured") : t("settings.notConfigured")}
          >
            <input
              id="dashscope-key"
              type="password"
              className={`${FIELD} w-full sm:w-64`}
              value={dashscopeKey}
              placeholder="••••••••"
              onChange={(event) => setDashscopeKey(event.target.value)}
            />
          </Row>
          <StackRow>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={savingCred !== null}
                onClick={saveDashscopeKey}
              >
                {t("settings.asr.saveAliyunKey")}
              </Button>
              <SavedBadge text={dashscopeSaved} isError={dashscopeSavedErr} />
            </div>
          </StackRow>
        </Group>
      )}
    </>
  );
}

import { type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { AUTO_SENSITIVITY, DEFAULT_SLIDES_SENSITIVITY } from "@/lib/slides";
import { FIELD, Select, Group, Row, StackRow, SavedBadge } from "@/features/settings/primitives";
import type { SettingsForm } from "@/features/settings/useSettingsForm";

/** 课件提取与文字识别。 */
export function CoursewareSection({ form }: { form: SettingsForm }) {
  const { t } = useTranslation();
  const {
    slidesAutoExtract,
    ocrBackend,
    ocrType,
    ocrKeyId,
    setOcrKeyId,
    ocrSecret,
    setOcrSecret,
    ocrSaved,
    ocrSavedErr,
    deepseekModel,
    setDeepseekModel,
    deepseekBaseUrl,
    setDeepseekBaseUrl,
    deepseekKey,
    setDeepseekKey,
    deepseekSaved,
    deepseekSavedErr,
    slidesSensitivity,
    savingCred,
    ocrSecret2,
    deepseekSecret,
    slidesAuto,
    slidesSliderValue,
    changeSlidesSensitivity,
    changeSlidesAutoExtract,
    changeOcrBackend,
    changeOcrType,
    saveOcrCreds,
    saveDeepseekOcr,
  } = form;

  return (
    <>
      <Group
        header={t("settings.ocr.title")}
      >
        <Row label={t("settings.ocr.engine")} htmlFor="ocr-backend">
          <div className="w-full sm:w-56">
            <Select
              id="ocr-backend"
              value={ocrBackend}
              onChange={(event) => void changeOcrBackend(event.target.value)}
            >
              <option value="local">{t("settings.ocr.localOcr")}</option>
              <option value="aliyun">{t("settings.ocr.aliyunOcr")}</option>
              <option value="deepseek">{t("settings.ocr.deepseekOcr")}</option>
            </Select>
          </div>
        </Row>

        {ocrBackend === "aliyun" && (
          <>
            <Row label={t("settings.ocr.aliyunType")} htmlFor="aliyun-ocr-type">
              <div className="w-full sm:w-56">
                <Select
                  id="aliyun-ocr-type"
                  value={ocrType}
                  onChange={(event) => void changeOcrType(event.target.value)}
                >
                  <option value="Advanced">{t("settings.ocr.advanced")}</option>
                  <option value="General">{t("settings.ocr.general")}</option>
                  <option value="HandWriting">{t("settings.ocr.handwriting")}</option>
                  <option value="MultiLanguage">{t("settings.ocr.multiLanguage")}</option>
                  <option value="Table">{t("settings.ocr.table")}</option>
                </Select>
              </div>
            </Row>
            <Row label="AccessKey ID" htmlFor="aliyun-ocr-key-id">
              <input
                id="aliyun-ocr-key-id"
                type="text"
                className={`${FIELD} w-full sm:w-64`}
                value={ocrKeyId}
                placeholder={t("settings.ocr.accessKeyPlaceholder")}
                onChange={(event) => setOcrKeyId(event.target.value)}
              />
            </Row>
            <Row
              label="AccessKey Secret"
              htmlFor="aliyun-ocr-secret"
              hint={
                ocrSecret2.configured
                  ? t("settings.ocr.aliyunSecretConfigured")
                  : t("settings.ocr.aliyunSecretNotConfigured")
              }
            >
              <input
                id="aliyun-ocr-secret"
                type="password"
                className={`${FIELD} w-full sm:w-64`}
                value={ocrSecret}
                placeholder="••••••••"
                onChange={(event) => setOcrSecret(event.target.value)}
              />
            </Row>
            <StackRow>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={savingCred !== null}
                  onClick={saveOcrCreds}
                >
                  {t("settings.ocr.saveAliyunOcr")}
                </Button>
                <SavedBadge text={ocrSaved} isError={ocrSavedErr} />
              </div>
            </StackRow>
          </>
        )}

        {ocrBackend === "deepseek" && (
          <>
            <Row
              label={t("settings.ocr.deepseekModel")}
              htmlFor="deepseek-ocr-model"
            >
              <input
                id="deepseek-ocr-model"
                type="text"
                className={`${FIELD} w-full sm:w-64`}
                value={deepseekModel}
                placeholder="deepseek-v4-flash-vision-exp"
                onChange={(event) => setDeepseekModel(event.target.value)}
              />
            </Row>
            <Row
              label={t("settings.ocr.deepseekBaseUrl")}
              htmlFor="deepseek-ocr-base-url"
            >
              <input
                id="deepseek-ocr-base-url"
                type="text"
                className={`${FIELD} w-full sm:w-64`}
                value={deepseekBaseUrl}
                placeholder="https://api.deepseek.com"
                onChange={(event) => setDeepseekBaseUrl(event.target.value)}
              />
            </Row>
            <Row
              label={t("settings.ocr.deepseekApiKey")}
              htmlFor="deepseek-ocr-key"
              hint={
                deepseekSecret.configured
                  ? t("settings.ocr.deepseekConfigured")
                  : t("settings.ocr.deepseekNotConfigured")
              }
            >
              <input
                id="deepseek-ocr-key"
                type="password"
                className={`${FIELD} w-full sm:w-64`}
                value={deepseekKey}
                placeholder="••••••••"
                onChange={(event) => setDeepseekKey(event.target.value)}
              />
            </Row>
            <StackRow>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={savingCred !== null}
                  onClick={saveDeepseekOcr}
                >
                  {t("settings.ocr.saveDeepseekOcr")}
                </Button>
                <SavedBadge text={deepseekSaved} isError={deepseekSavedErr} />
              </div>
            </StackRow>
          </>
        )}
      </Group>

      <Group
        header={t("settings.courseware.title")}
      >
        <Row
          label={t("settings.courseware.autoExtract")}
          htmlFor="slides-auto-extract"
        >
          <Switch
            id="slides-auto-extract"
            aria-label={t("settings.courseware.autoExtractLabel")}
            checked={slidesAutoExtract}
            onCheckedChange={(next) => void changeSlidesAutoExtract(next)}
          />
        </Row>
        <Row
          label={t("settings.courseware.autoSensitivity")}
          htmlFor="slides-auto"
        >
          <Switch
            id="slides-auto"
            aria-label={t("settings.courseware.autoSensitivityLabel")}
            checked={slidesAuto}
            onCheckedChange={(next) =>
              changeSlidesSensitivity(next ? AUTO_SENSITIVITY : DEFAULT_SLIDES_SENSITIVITY)
            }
          />
        </Row>
        <StackRow label={t("settings.courseware.sensitivity")}>
          <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
            <span>{t("settings.courseware.low")}</span>
            <input
              aria-label={t("settings.courseware.sensitivityLabel")}
              type="range"
              min={0}
              max={100}
              step={5}
              disabled={slidesAuto}
              value={slidesSliderValue}
              onChange={(event) => changeSlidesSensitivity(Number(event.target.value))}
              className="ca-slider flex-1 disabled:opacity-40"
              style={{ "--slider-fill": `${slidesSliderValue}%` } as CSSProperties}
            />
            <span>{t("settings.courseware.high")}</span>
            <span className="w-8 text-right tabular-nums text-[var(--text-faint)]">
              {slidesAuto ? t("settings.theme.auto") : slidesSensitivity}
            </span>
          </div>
        </StackRow>
      </Group>
    </>
  );
}

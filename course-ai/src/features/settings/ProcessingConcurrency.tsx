import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { Switch } from "@/ui/switch";
import { Group, Row, Select } from "@/features/settings/primitives";

const KEY = "processing_concurrency";
/** 导入视频后立刻跑流水线（本地文件、网络视频、网盘都算）；没设置过算开。 */
const AUTO_KEY = "auto_process_imports";
const DEFAULT = 2;
const OPTIONS = [1, 2, 3, 4, 5, 6];

/**
 * 同时处理几个视频（其余按「开始处理」的先后排队）。本地识别另外一次只跑一个视频，
 * 不受这里的数字影响——那是显卡 / CPU 的硬约束，不是偏好。
 */
export function ProcessingConcurrency() {
  const { t } = useTranslation();
  const [value, setValue] = useState(DEFAULT);
  const [autoProcess, setAutoProcess] = useState(true);

  useEffect(() => {
    let alive = true;
    void ipc.settings
      .get(KEY)
      .then((saved) => {
        const parsed = Number(saved);
        if (alive && OPTIONS.includes(parsed)) setValue(parsed);
      })
      .catch(() => {});
    void ipc.settings
      .get(AUTO_KEY)
      .then((saved) => {
        if (alive) setAutoProcess(saved !== "false");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Group header={t("settings.processing.title")}>
      <Row
        label={t("settings.processing.autoProcess")}
        hint={t("settings.processing.autoProcessHint")}
        htmlFor="auto-process-imports"
        layout="inline"
      >
        <Switch
          id="auto-process-imports"
          checked={autoProcess}
          onCheckedChange={(next) => {
            setAutoProcess(next);
            void ipc.settings.set(AUTO_KEY, next ? "true" : "false").catch(() => {});
          }}
        />
      </Row>
      <Row
        label={t("settings.processing.concurrency")}
        hint={t("settings.processing.concurrencyHint")}
        htmlFor="processing-concurrency"
      >
        <div className="w-full sm:w-28">
          <Select
            id="processing-concurrency"
            value={String(value)}
            onChange={(event) => {
              const next = Number(event.target.value);
              setValue(next);
              void ipc.settings.set(KEY, String(next)).catch(() => {});
            }}
          >
            {OPTIONS.map((option) => (
              <option key={option} value={option}>
                {t("settings.processing.videos", { count: option })}
              </option>
            ))}
          </Select>
        </div>
      </Row>
    </Group>
  );
}

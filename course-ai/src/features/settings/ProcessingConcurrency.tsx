import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { Group, Row, Select } from "@/features/settings/primitives";

const KEY = "processing_concurrency";
const DEFAULT = 2;
const OPTIONS = [1, 2, 3, 4, 5, 6];

/**
 * 同时处理几个视频（其余按「开始处理」的先后排队）。本地识别另外一次只跑一个视频，
 * 不受这里的数字影响——那是显卡 / CPU 的硬约束，不是偏好。
 */
export function ProcessingConcurrency() {
  const { t } = useTranslation();
  const [value, setValue] = useState(DEFAULT);

  useEffect(() => {
    let alive = true;
    void ipc.settings
      .get(KEY)
      .then((saved) => {
        const parsed = Number(saved);
        if (alive && OPTIONS.includes(parsed)) setValue(parsed);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Group header={t("settings.processing.title")}>
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

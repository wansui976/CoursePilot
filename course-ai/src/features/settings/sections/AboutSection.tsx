import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { humanizeError } from "@/lib/errors";
import type { UpdateCheck } from "@/lib/ipc/types";
import {
  checkForUpdate,
  readAutoCheck,
  useRunningVersion,
  writeAutoCheck,
} from "@/lib/updateCheck";
import { Group, Row } from "@/features/settings/primitives";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; result: UpdateCheck }
  | { kind: "failed"; error: unknown };

/** 关于：当前版本、手动检查更新、自动检查的开关。 */
export function AboutSection() {
  const { t, i18n } = useTranslation();
  const running = useRunningVersion();
  const [auto, setAuto] = useState(() => readAutoCheck());
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });

  async function checkNow() {
    setCheck({ kind: "checking" });
    try {
      setCheck({ kind: "done", result: await checkForUpdate() });
    } catch (error) {
      setCheck({ kind: "failed", error });
    }
  }

  let status: ReactNode = null;
  if (check.kind === "done" && check.result.newer) {
    const url = check.result.url;
    status = (
      <>
        {t("settings.about.available", { version: check.result.latest })}{" "}
        <button
          type="button"
          className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={() => void openUrl(url)}
        >
          {t("settings.about.view")}
        </button>
      </>
    );
  } else if (check.kind === "done") {
    status = t("settings.about.upToDate");
  } else if (check.kind === "failed") {
    status = t("settings.about.failed", { error: humanizeError(check.error, i18n.language) });
  }

  return (
    <Group header={t("settings.about.title")}>
      <Row label={t("settings.about.version")}>
        <span className="ca-t-sm tabular-nums text-[var(--text-muted)]">{running ?? "…"}</span>
      </Row>
      <Row label={t("settings.about.update")} hint={status}>
        <Button
          variant="outline"
          size="sm"
          disabled={check.kind === "checking"}
          onClick={() => void checkNow()}
        >
          {check.kind === "checking" ? t("settings.about.checking") : t("settings.about.check")}
        </Button>
      </Row>
      <Row
        label={t("settings.about.autoCheck")}
        hint={t("settings.about.autoCheckHint")}
        htmlFor="update-auto-check"
      >
        <Switch
          id="update-auto-check"
          aria-label={t("settings.about.autoCheck")}
          checked={auto}
          onCheckedChange={(next) => {
            writeAutoCheck(next);
            setAuto(next);
          }}
        />
      </Row>
    </Group>
  );
}

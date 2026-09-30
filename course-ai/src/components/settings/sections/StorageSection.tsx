import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DatabaseBackupAction } from "@/components/DatabaseBackupAction";
import { FIELD, Group, Row, StackRow } from "../primitives";
import type { SettingsForm } from "../useSettingsForm";

/** 存储位置与数据备份。 */
export function StorageSection({ form }: { form: SettingsForm }) {
  const { t } = useTranslation();
  const {
    root,
    pickRoot,
    clearRoot,
  } = form;

  return (
    <>
      <Group
        header={t("settings.storage.title")}
        footnote={t("settings.storage.footnote")}
      >
        <StackRow label={t("settings.storage.defaultRoot")}>
          <div className="flex items-center gap-2">
            <input className={FIELD} value={root} readOnly placeholder={t("settings.storage.notSet")} />
            <Button size="sm" variant="outline" onClick={pickRoot}>
              {t("settings.storage.select")}
            </Button>
            {root && (
              <Button size="sm" variant="ghost" onClick={() => void clearRoot()}>
                {t("settings.storage.clear")}
              </Button>
            )}
          </div>
        </StackRow>
      </Group>
      <Group
        header={t("settings.storage.security")}
        footnote={t("settings.storage.securityFootnote")}
      >
        <Row
          label={t("backup.label")}
          hint={t("backup.hint")}
        >
          <DatabaseBackupAction />
        </Row>
      </Group>
    </>
  );
}

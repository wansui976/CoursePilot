import { useCallback, useEffect, useState } from "react";
import { ipc, type PaddleOcrStatus } from "@/lib/ipc";

/** 平台支不支持 PaddleOCR（手机上用系统 OCR，没有这一项）。查不出来就当不支持，不往下拉框里加。 */
export function usePaddleOcrStatus() {
  const [status, setStatus] = useState<PaddleOcrStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await ipc.ocrModel.status());
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { status, refresh };
}

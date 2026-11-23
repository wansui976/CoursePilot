import { useEffect, useState } from "react";

/** 当前时间，每分钟更新一次（窗外天色、台灯、节气用）。 */
export function useNow(stepMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

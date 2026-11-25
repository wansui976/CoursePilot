import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LocateFixed, Search, X } from "lucide-react";
import { ipc } from "@/lib/ipc";
import type { WeatherPlace } from "@/lib/ipc/system";
import { humanizeError } from "@/lib/errors";
import { roundCoord, useWeatherPlace } from "@/stores/weatherPlace";
import { Button } from "@/ui/button";
import { FIELD, StackRow } from "../primitives";

/** 浏览器 / WebView 的定位，包成 Promise；拿不到就抛出原因。 */
function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("unavailable"));
      return;
    }
    try {
      // 只要大致位置（坐标取两位小数）：不开高精度，手机上不用等 GPS。
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        maximumAge: 3_600_000,
        timeout: 15_000,
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 设置 → 外观 → 窗外的天气：搜城市或用当前位置选一个地点。没选就不查天气。
 * 只把大致坐标（两位小数）或城市名发给 Open-Meteo，不带任何账号信息。
 */
export function WeatherPlaceRow() {
  const { t, i18n } = useTranslation();
  const place = useWeatherPlace((state) => state.place);
  const setPlace = useWeatherPlace((state) => state.setPlace);
  const [query, setQuery] = useState("");
  const [locateError, setLocateError] = useState<string | null>(null);
  const search = useMutation({ mutationFn: (text: string) => ipc.weather.findPlace(text, i18n.language) });

  function choose(next: WeatherPlace) {
    setPlace(next);
    setQuery("");
    search.reset();
  }

  async function locate() {
    setLocateError(null);
    try {
      const position = await currentPosition();
      choose({
        name: t("settings.appearance.weatherHere"),
        region: "",
        latitude: roundCoord(position.coords.latitude),
        longitude: roundCoord(position.coords.longitude),
      });
    } catch {
      setLocateError(t("settings.appearance.weatherLocateFailed"));
    }
  }

  return (
    <StackRow label={t("settings.appearance.weather")} hint={t("settings.appearance.weatherHint")}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--text-muted)]">{t("settings.appearance.weatherPlace")}</span>
          <span className="font-medium text-[var(--text-strong)]">
            {place ? [place.name, place.region].filter(Boolean).join("，") : t("settings.appearance.weatherOff")}
          </span>
          {place && (
            <Button variant="ghost" size="sm" onClick={() => setPlace(null)}>
              <X />
              {t("settings.appearance.weatherClear")}
            </Button>
          )}
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) search.mutate(query.trim());
          }}
        >
          <input
            className={`${FIELD} min-w-0 flex-1`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("settings.appearance.weatherSearchPlaceholder")}
            aria-label={t("settings.appearance.weatherSearchPlaceholder")}
          />
          <Button type="submit" variant="default" size="sm" disabled={!query.trim() || search.isPending}>
            <Search />
            {t("settings.appearance.weatherSearch")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void locate()}>
            <LocateFixed />
            {t("settings.appearance.weatherLocate")}
          </Button>
        </form>
        {locateError && <p className="text-xs text-[var(--status-err)]">{locateError}</p>}
        {search.isError && <p className="text-xs text-[var(--status-err)]">{humanizeError(search.error, i18n.language)}</p>}
        {search.data && search.data.length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">{t("settings.appearance.weatherNoResult")}</p>
        )}
        {search.data && search.data.length > 0 && (
          <ul className="flex flex-col gap-1" aria-label={t("settings.appearance.weatherResults")}>
            {search.data.map((hit) => (
              <li key={`${hit.latitude},${hit.longitude}`}>
                <button
                  type="button"
                  onClick={() => choose(hit)}
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--surface-card-hover)]"
                >
                  <span className="text-[var(--text-strong)]">{hit.name}</span>
                  {hit.region && <span className="ml-2 text-xs text-[var(--text-muted)]">{hit.region}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </StackRow>
  );
}

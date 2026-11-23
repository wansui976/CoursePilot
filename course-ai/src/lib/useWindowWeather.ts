import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { useWeatherPlace } from "@/stores/weatherPlace";

const TWENTY_MIN = 20 * 60_000;

/** 窗外的当前天气：选了地点才查，20 分钟刷新一次；查不到就是 null（窗外只按时辰画）。 */
export function useWindowWeather(enabled: boolean) {
  const place = useWeatherPlace((state) => state.place);
  const query = useQuery({
    queryKey: qk.weather(place?.latitude ?? 0, place?.longitude ?? 0),
    queryFn: () => ipc.weather.now(place!.latitude, place!.longitude),
    enabled: enabled && place != null,
    staleTime: TWENTY_MIN,
    refetchInterval: TWENTY_MIN,
    retry: 1,
  });
  return { place, weather: place ? (query.data ?? null) : null };
}

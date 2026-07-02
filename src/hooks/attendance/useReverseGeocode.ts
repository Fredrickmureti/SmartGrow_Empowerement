/**
 * useReverseGeocode — Nominatim reverse geocoding with react-query caching.
 *
 * Keyed by rounded (lat,lng) so nearby fixes share the same lookup. 24h
 * stale time respects Nominatim's usage policy; we also serialise calls
 * 1 req/s globally via a tiny in-memory mutex.
 */
import { useQuery } from "@tanstack/react-query";

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = Math.max(0, 1050 - (Date.now() - lastCallAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export function useReverseGeocode(lat: number | null | undefined, lng: number | null | undefined) {
  const hasCoords = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);
  const rLat = hasCoords ? Number(lat).toFixed(4) : null;
  const rLng = hasCoords ? Number(lng).toFixed(4) : null;

  return useQuery({
    queryKey: ["reverse-geocode", rLat, rLng],
    enabled: hasCoords,
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24,
    retry: false,
    queryFn: async (): Promise<string | null> => {
      if (!hasCoords) return null;
      await throttle();
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${rLat}&lon=${rLng}&zoom=18&addressdetails=1`;
      try {
        const r = await fetch(url, {
          headers: { Accept: "application/json" },
          referrerPolicy: "no-referrer",
        });
        if (!r.ok) return null;
        const j = await r.json();
        return (j?.display_name as string) ?? null;
      } catch {
        return null;
      }
    },
  });
}

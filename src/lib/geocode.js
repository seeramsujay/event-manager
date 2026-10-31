import { TtlCache } from "./ttlCache.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "EventPlannerAI/1.0 (https://event-manager-alpha-hazel.vercel.app)";

/**
 * Service to reverse geocode latitude and longitude to a human-readable city/region.
 *
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchFn]
 * @param {TtlCache} [deps.cache]
 * @returns {{ reverse: (lat: number, lon: number) => Promise<string> }}
 */
export function createGeocodeService({ fetchFn = fetch, cache = new TtlCache({ maxEntries: 200, ttlMs: 3600_000 }) } = {}) {
  return {
    async reverse(lat, lon) {
      if (typeof lat !== "number" || typeof lon !== "number" || Number.isNaN(lat) || Number.isNaN(lon)) {
        throw new Error("Latitude and longitude must be numbers");
      }
      if (lat < -90 || lat > 90) throw new Error("Latitude must be between -90 and 90");
      if (lon < -180 || lon > 180) throw new Error("Longitude must be between -180 and 180");

      const roundedLat = lat.toFixed(3);
      const roundedLon = lon.toFixed(3);
      const cacheKey = `${roundedLat},${roundedLon}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const url = `${NOMINATIM_URL}?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=12`;
      const res = await fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        throw new Error(`Geocoding failed with status ${res.status}`);
      }

      const data = await res.json();
      const addr = data.address || {};
      const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || "";
      const state = addr.state || addr.region || "";
      const country = addr.country || "";
      const parts = [city, state, country].filter(Boolean);
      const location = parts.length > 0 ? parts.join(", ") : (data.name || `${roundedLat}, ${roundedLon}`);

      cache.set(cacheKey, location);
      return location;
    },
  };
}

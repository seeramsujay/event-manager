import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createGeocodeService } from "../src/lib/geocode.js";
import { TtlCache } from "../src/lib/ttlCache.js";

describe("createGeocodeService", () => {
  test("reverses coordinates to human-readable location", async () => {
    let requestedUrl;
    let requestedHeaders;
    const mockFetch = async (url, opts) => {
      requestedUrl = url;
      requestedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({
          address: { city: "Seattle", state: "Washington", country: "United States" },
        }),
      };
    };

    const service = createGeocodeService({ fetchFn: mockFetch });
    const location = await service.reverse(47.6062, -122.3321);

    assert.equal(location, "Seattle, Washington, United States");
    assert.match(requestedUrl, /lat=47\.6062&lon=-122\.3321/);
    assert.match(requestedHeaders["User-Agent"], /EventPlannerAI/);
  });

  test("uses cached results for nearby coordinates without re-fetching", async () => {
    let calls = 0;
    const mockFetch = async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ address: { city: "Paris", country: "France" } }),
      };
    };

    const cache = new TtlCache();
    const service = createGeocodeService({ fetchFn: mockFetch, cache });

    const loc1 = await service.reverse(48.8566, 2.3522);
    // 48.8569 rounds to 48.857, which matches 48.8566's rounded value
    const loc2 = await service.reverse(48.8569, 2.3522);

    assert.equal(loc1, "Paris, France");
    assert.equal(loc2, "Paris, France");
    assert.equal(calls, 1);
  });

  test("handles partial address data and falls back to name or coordinates", async () => {
    const serviceWithName = createGeocodeService({
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ address: {}, name: "Central Park" }),
      }),
    });
    assert.equal(await serviceWithName.reverse(40.785, -73.968), "Central Park");

    const serviceWithEmpty = createGeocodeService({
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ address: {} }),
      }),
    });
    assert.equal(await serviceWithEmpty.reverse(40.785, -73.968), "40.785, -73.968");
  });

  test("validates input ranges and types", async () => {
    const service = createGeocodeService();
    await assert.rejects(() => service.reverse("40", -73), /Latitude and longitude must be numbers/);
    await assert.rejects(() => service.reverse(Number.NaN, -73), /Latitude and longitude must be numbers/);
    await assert.rejects(() => service.reverse(95, 0), /Latitude must be between -90 and 90/);
    await assert.rejects(() => service.reverse(-95, 0), /Latitude must be between -90 and 90/);
    await assert.rejects(() => service.reverse(0, 185), /Longitude must be between -180 and 180/);
    await assert.rejects(() => service.reverse(0, -185), /Longitude must be between -180 and 180/);
  });

  test("rejects when upstream geocoding service returns an HTTP error", async () => {
    const service = createGeocodeService({
      fetchFn: async () => ({ ok: false, status: 503 }),
    });
    await assert.rejects(() => service.reverse(40.7128, -74.006), /Geocoding failed with status 503/);
  });
});

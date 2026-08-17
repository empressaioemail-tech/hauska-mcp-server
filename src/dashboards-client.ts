/**
 * Dashboards HTTP client. G-61 item 6 / G-62 item 5 / G-63 item 5.
 * Calls the Dashboards product service, not cortex-api and not the live city.
 * Zero DSN. Does not read LEGACY_BACKEND_URL.
 * Compose and adapter-kinds are public: no DASHBOARDS_API_KEY.
 * Private city packs forward X-Hauska-Key. template-city keeps the service Bearer.
 */

import { LegacyHttpError, LegacyUnreachableError } from "./legacy-client.js";

const DEFAULT_TIMEOUT_MS = 30_000;
export const TEMPLATE_CITY_KEY = "template-city";
const DEFAULT_CITY_KEY = TEMPLATE_CITY_KEY;
const COMPOSE_PARCEL_NODE_ID = /^\d{5}:[A-Za-z0-9._-]+$/;
const FORBIDDEN =
  /cortex-api|legacy-design-tools|fancy-fire|smartcity-os-prod|tiny-art|smartcityos\.io|postgres:\/\/|neon\.tech/i;

export function dashboardsBackendUrl(): string {
  const url = (process.env.DASHBOARDS_BACKEND_URL ?? "").replace(/\/$/, "");
  if (!url) {
    throw new Error("DASHBOARDS_BACKEND_URL is required");
  }
  if (FORBIDDEN.test(url)) {
    throw new Error(
      "DASHBOARDS_BACKEND_URL refuses cortex-api, legacy-design-tools, fancy-fire, smartcity-os-prod, tiny-art, smartcityos.io, postgres://, and neon.tech",
    );
  }
  return url;
}

function serviceToken(): string {
  return process.env.DASHBOARDS_API_KEY ?? "";
}

async function dashboardsFetch<T>(
  path: string,
  opts: {
    authorization: "service" | "omit";
    hauskaKey?: string;
  } = { authorization: "service" },
): Promise<T> {
  const url = `${dashboardsBackendUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "hauska-mcp-server/g11",
  };
  if (opts.authorization === "service") {
    const apiKey = serviceToken();
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  }
  const hauskaKey = opts.hauskaKey?.trim();
  if (hauskaKey) headers["x-hauska-key"] = hauskaKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    throw new LegacyUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new LegacyHttpError(res.status, url, text.slice(0, 500));
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export const dashboardsClient = {
  listLenses() {
    return dashboardsFetch<Record<string, unknown>>("/api/lenses");
  },
  listAdapterKinds() {
    return dashboardsFetch<Record<string, unknown>>("/api/adapter-kinds", {
      authorization: "omit",
    });
  },
  getCityPack(cityKey: string, opts?: { hauskaKey?: string }) {
    const isTemplate = cityKey === TEMPLATE_CITY_KEY;
    return dashboardsFetch<Record<string, unknown>>(
      `/api/city-packs/${encodeURIComponent(cityKey)}`,
      isTemplate
        ? { authorization: "service" }
        : { authorization: "omit", hauskaKey: opts?.hauskaKey },
    );
  },
  composeCityManager({
    parcelNodeId,
    cityKey = DEFAULT_CITY_KEY,
  }: {
    parcelNodeId: string;
    cityKey?: string;
  }) {
    if (!COMPOSE_PARCEL_NODE_ID.test(parcelNodeId)) {
      throw new Error(
        "parcelNodeId must match county_fips:prop_id (e.g. 48021:34137)",
      );
    }
    const key = cityKey.trim() || DEFAULT_CITY_KEY;
    const path =
      `/api/lenses/city-manager/compose?parcelNodeId=${parcelNodeId}` +
      `&cityKey=${encodeURIComponent(key)}`;
    return dashboardsFetch<Record<string, unknown>>(path, {
      authorization: "omit",
    });
  },
};

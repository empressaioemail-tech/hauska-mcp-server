/**
 * Dashboards HTTP client. G-61 item 6.
 * Calls the Dashboards product service, not cortex-api and not the live city.
 * Zero DSN. Does not read LEGACY_BACKEND_URL.
 */

import { LegacyHttpError, LegacyUnreachableError } from "./legacy-client.js";

const DEFAULT_TIMEOUT_MS = 30_000;
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

async function dashboardsFetch<T>(path: string): Promise<T> {
  const url = `${dashboardsBackendUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "hauska-mcp-server/g61",
  };
  const apiKey = serviceToken();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

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
  getCityPack(cityKey: string) {
    return dashboardsFetch<Record<string, unknown>>(
      `/api/city-packs/${encodeURIComponent(cityKey)}`,
    );
  },
};

/**
 * Smart Files HTTP client — files service /api/smart-files/* (G-58).
 * Does not use LEGACY_BACKEND_URL. Refuses cortex-api.
 */

import {
  LegacyHttpError,
  LegacyUnreachableError,
} from "./legacy-client.js";

const DEFAULT_BACKEND_URL = "http://localhost:8080";
const DEFAULT_TIMEOUT_MS = 30_000;

export function smartFilesBackendUrl(): string {
  const url = (process.env.SMART_FILES_BACKEND_URL ?? DEFAULT_BACKEND_URL).replace(
    /\/$/,
    "",
  );
  if (/cortex-api/i.test(url)) {
    throw new Error(
      "SMART_FILES_BACKEND_URL refuses cortex-api; Smart Files is its own service",
    );
  }
  return url;
}

function serviceToken(): string {
  return process.env.SMART_FILES_API_KEY ?? "";
}

async function smartFilesFetch<T>(path: string): Promise<T> {
  const url = `${smartFilesBackendUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "hauska-mcp-server/0.1",
  };
  const apiKey = serviceToken();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
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

export interface SmartFileFolderWire {
  folderId: string;
  label: string;
  scopeType: string;
  scopeId: string;
  accessPolicy: string;
  parentFolderId: string | null;
}

export interface SmartFileFolderFileWire {
  entityId: string;
  title: string;
  accessPolicy: string;
  currentVersion: number;
  scopeType: string;
  scopeId: string;
  docSlug: string;
  placementCount: number;
}

export const smartFilesClient = {
  listFolders(scopeType: string, scopeId: string) {
    const q = new URLSearchParams({ scopeType, scopeId });
    return smartFilesFetch<{ folders: SmartFileFolderWire[]; servedAt: string }>(
      `/api/smart-files/folders?${q}`,
    );
  },

  listFolderFiles(folderId: string) {
    return smartFilesFetch<{
      folder: SmartFileFolderWire;
      files: SmartFileFolderFileWire[];
      countingRule: string;
      servedAt: string;
    }>(`/api/smart-files/folders/${encodeURIComponent(folderId)}/files`);
  },

  readFile(entityId: string, version?: number) {
    const q = version != null ? `?version=${version}` : "";
    return smartFilesFetch<Record<string, unknown>>(
      `/api/smart-files/files/${encodeURIComponent(entityId)}${q}`,
    );
  },

  listPlacements(entityId: string) {
    return smartFilesFetch<{ entityId: string; placements: unknown[]; servedAt: string }>(
      `/api/smart-files/files/${encodeURIComponent(entityId)}/placements`,
    );
  },
};

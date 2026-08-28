// Engine API client — gate-fronted reasoning tier (ADR-008).
//
// Proxies to hauska-engine services/engine-api. Separate from the
// retrieval-api hauska-client.ts path. Only the MCP gate calls this
// service in production.

import { logger } from "./logger.js";
import {
  gateFrontHeadersFromContext,
  type GateFrontAccessTier,
  type GateFrontProduct,
} from "./gate-front.js";
import {
  MAP_LAYERS_PACKAGE_ID,
  type MapLayersAssembleEngineEnvelope,
  type MapLayersAssembleRequest,
} from "./map-layers-contract.js";
import {
  TERRAIN_EXPORT_PACKAGE_ID,
  terrainExportDownloadPath,
  type TerrainExportFormat,
  type TerrainExportRefreshRequest,
  type TerrainExportRefreshResponse,
} from "./terrain-export-contract.js";
import {
  SITE_PLAN_EXPORT_PACKAGE_ID,
  sitePlanExportDownloadPath,
  type SitePlanExportFormat,
  type SitePlanExportRefreshRequest,
  type SitePlanExportRefreshResponse,
} from "./site-plan-export-contract.js";
import {
  DOSSIER_EXPORT_PACKAGE_ID,
  dossierExportDownloadPath,
  type DossierExportRefreshRequest,
  type DossierExportRefreshResponse,
} from "./dossier-export-contract.js";
import { buildSignedGateContext } from "./gate-context.js";

const DEFAULT_ENGINE_API_URL = "http://localhost:8080";
const DEFAULT_TIMEOUT_MS = 30_000;

// Chain budget for the paid export calls (site-plan / terrain):
// PE's Vercel BFF function caps at 60s (apps/property-explorer/vercel.json
// maxDuration 60), so the MCP→engine hop must abort under ~50s to leave the
// BFF headroom to return an honest error instead of a Vercel hard kill.
// A warm site-plan refresh runs ~23s live; a cold one exceeds the old 30s
// default, which is exactly the bug this budget fixes.
const SITE_PLAN_REFRESH_TIMEOUT_MS = 50_000;
const EXPORT_DOWNLOAD_TIMEOUT_MS = 45_000;

/** Tenancy T1 gate-signed context headers. */
const GATE_CONTEXT_HEADER = "X-Hauska-Gate-Context";
const GATE_SIGNATURE_HEADER = "X-Hauska-Gate-Signature";

function engineApiUrl(): string {
  return (
    process.env.HAUSKA_ENGINE_API_URL ??
    process.env.HAUSKA_BACKEND_URL ??
    DEFAULT_ENGINE_API_URL
  );
}

function engineApiGateToken(): string {
  return (
    process.env.HAUSKA_ENGINE_API_GATE_TOKEN ??
    process.env.HAUSKA_ENGINE_API_KEY ??
    ""
  );
}

function gateSigningKey(): string | undefined {
  return process.env.GATE_CONTEXT_SIGNING_KEY?.trim() || undefined;
}

export class EngineApiHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(
      `Engine API request failed (${status}) for ${url}: ${body.slice(0, 200)}`,
    );
    this.name = "EngineApiHttpError";
  }
}

export class EngineApiUnreachableError extends Error {
  constructor(public readonly url: string, cause: unknown) {
    super(`Engine API unreachable at ${url}: ${String(cause)}`);
    this.name = "EngineApiUnreachableError";
    this.cause = cause;
  }
}

/**
 * The engine call was aborted by OUR client-side timeout — the service may
 * be up (e.g. a cold-start or long render), so this must never be reported
 * as "unreachable" or as a gate/auth problem. Subclasses
 * EngineApiUnreachableError so existing instanceof fallbacks still catch it;
 * consumers that care check this class first.
 */
export class EngineApiTimeoutError extends EngineApiUnreachableError {
  constructor(
    url: string,
    public readonly timeoutMs: number,
    cause: unknown,
  ) {
    super(url, cause);
    this.name = "EngineApiTimeoutError";
    this.message = `Engine API call timed out after ${timeoutMs}ms at ${url}`;
  }
}

async function engineApiFetch<T>(
  path: string,
  init: RequestInit & {
    timeoutMs?: number;
    gateHeaders: Record<string, string>;
    gateContext?: {
      tenant: string | null;
      product: string;
      tier: string;
      platformInternal: boolean;
    };
  },
): Promise<T> {
  const url = `${engineApiUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "hauska-mcp-server/0.1",
    ...init.gateHeaders,
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = engineApiGateToken();
  if (token) headers.authorization = `Bearer ${token}`;

  // Attach signed gate context (T1 producer side). If the signing key
  // is unset, skip stamping — behavior identical to today.
  const key = gateSigningKey();
  if (key && init.gateContext) {
    try {
      const { payload, signature } = buildSignedGateContext(
        {
          tenant: init.gateContext.tenant,
          product: init.gateContext.product,
          tier: init.gateContext.tier,
          keyId: null,
          platformInternal: init.gateContext.platformInternal,
        },
        key,
      );
      headers[GATE_CONTEXT_HEADER] = payload;
      headers[GATE_SIGNATURE_HEADER] = signature;
    } catch (err) {
      logger.warn("gate_context_signing_failed", {
        url,
        error: String(err),
      });
    }
  }

  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      body: init.body,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) throw new EngineApiTimeoutError(url, timeoutMs, err);
    throw new EngineApiUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<no-body>");
    logger.warn("engine_api_http_error", {
      url,
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new EngineApiHttpError(res.status, url, body);
  }

  return (await res.json()) as T;
}

interface EngineApiGateContextInput {
  gateHeaders: Record<string, string>;
  gateContext?: {
    tenant: string | null;
    product: string;
    tier: string;
    platformInternal: boolean;
  };
  timeoutMs?: number;
}

async function engineApiFetchBytes(
  path: string,
  init: EngineApiGateContextInput,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = `${engineApiUrl()}${path}`;
  const headers: Record<string, string> = {
    accept: "*/*",
    "user-agent": "hauska-mcp-server/0.1",
    ...init.gateHeaders,
  };
  const token = engineApiGateToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const key = gateSigningKey();
  if (key && init.gateContext) {
    try {
      const { payload, signature } = buildSignedGateContext(
        {
          tenant: init.gateContext.tenant,
          product: init.gateContext.product,
          tier: init.gateContext.tier,
          keyId: null,
          platformInternal: init.gateContext.platformInternal,
        },
        key,
      );
      headers[GATE_CONTEXT_HEADER] = payload;
      headers[GATE_SIGNATURE_HEADER] = signature;
    } catch (err) {
      logger.warn("gate_context_signing_failed", {
        url,
        error: String(err),
      });
    }
  }

  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) throw new EngineApiTimeoutError(url, timeoutMs, err);
    throw new EngineApiUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<no-body>");
    logger.warn("engine_api_http_error", {
      url,
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new EngineApiHttpError(res.status, url, body);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() ??
    "application/octet-stream";
  return { bytes, contentType };
}

function gateContextFromGate(
  gate: MapLayersAssembleGateContext,
): EngineApiGateContextInput["gateContext"] {
  return {
    tenant: gate.tenantId,
    product: gate.gateProduct,
    tier: gate.accessTier,
    platformInternal: gate.accessTier === "platform-internal",
  };
}

function terrainExportGateHeaders(
  gate: MapLayersAssembleGateContext,
): Record<string, string> {
  return gateFrontHeadersFromContext({
    product: gate.gateProduct,
    packageId: TERRAIN_EXPORT_PACKAGE_ID,
    accessTier: gate.accessTier,
    tenantId: gate.tenantId,
    gateCredentialId: gate.gateCredentialId,
    requestId: gate.requestId,
  });
}

/**
 * Site-plan export (Wave 3, WDLL 7-8): same public-paid gate shape as
 * terrain-export, distinct packageId only so gate-front logging can tell
 * the two paid catalog exports apart.
 */
function sitePlanExportGateHeaders(
  gate: MapLayersAssembleGateContext,
): Record<string, string> {
  return gateFrontHeadersFromContext({
    product: gate.gateProduct,
    packageId: SITE_PLAN_EXPORT_PACKAGE_ID,
    accessTier: gate.accessTier,
    tenantId: gate.tenantId,
    gateCredentialId: gate.gateCredentialId,
    requestId: gate.requestId,
  });
}

/**
 * Property-dossier export (engine #174): same public-paid gate shape as
 * site-plan-export, distinct packageId only so gate-front logging can tell
 * the paid catalog exports apart.
 */
function dossierExportGateHeaders(
  gate: MapLayersAssembleGateContext,
): Record<string, string> {
  return gateFrontHeadersFromContext({
    product: gate.gateProduct,
    packageId: DOSSIER_EXPORT_PACKAGE_ID,
    accessTier: gate.accessTier,
    tenantId: gate.tenantId,
    gateCredentialId: gate.gateCredentialId,
    requestId: gate.requestId,
  });
}

export interface MapLayersAssembleGateContext {
  gateProduct: GateFrontProduct;
  accessTier: GateFrontAccessTier;
  tenantId: string;
  gateCredentialId: string;
  requestId?: string;
}

export const engineApiClient = {
  async assembleMapLayers(
    request: MapLayersAssembleRequest,
    gate: MapLayersAssembleGateContext,
  ): Promise<MapLayersAssembleEngineEnvelope> {
    const gateHeaders = gateFrontHeadersFromContext({
      product: gate.gateProduct,
      packageId: MAP_LAYERS_PACKAGE_ID,
      accessTier: gate.accessTier,
      tenantId: gate.tenantId,
      gateCredentialId: gate.gateCredentialId,
      requestId: gate.requestId,
    });

    return engineApiFetch<MapLayersAssembleEngineEnvelope>(
      "/v1/map-layers/assemble",
      {
        method: "POST",
        body: JSON.stringify(request),
        gateHeaders,
        gateContext: {
          tenant: gate.tenantId,
          product: gate.gateProduct,
          tier: gate.accessTier,
          platformInternal: gate.accessTier === "platform-internal",
        },
      },
    );
  },

  /**
   * Calibration overlay read-contract-per-atom (engine-api).
   * Returns 501 until engine-api ships the route; callers fall back locally.
   */
  async readAtomCalibration(
    atomDid: string,
    gate: MapLayersAssembleGateContext,
  ): Promise<{ readContract: unknown; overlay?: unknown }> {
    const gateHeaders = gateFrontHeadersFromContext({
      product: gate.gateProduct,
      packageId: "calibration-overlay",
      accessTier: gate.accessTier,
      tenantId: gate.tenantId,
      gateCredentialId: gate.gateCredentialId,
      requestId: gate.requestId,
    });

    return engineApiFetch<{ readContract: unknown; overlay?: unknown }>(
      `/v1/calibration/atoms/${encodeURIComponent(atomDid)}/read-contract`,
      {
        method: "GET",
        gateHeaders,
        gateContext: {
          tenant: gate.tenantId,
          product: gate.gateProduct,
          tier: gate.accessTier,
          platformInternal: gate.accessTier === "platform-internal",
        },
      },
    );
  },

  async refreshParcelTerrainExport(
    parcelNodeId: string,
    request: TerrainExportRefreshRequest,
    gate: MapLayersAssembleGateContext,
  ): Promise<TerrainExportRefreshResponse> {
    const gateHeaders = terrainExportGateHeaders(gate);
    const encoded = encodeURIComponent(parcelNodeId);
    return engineApiFetch<TerrainExportRefreshResponse>(
      `/v1/property-nodes/${encoded}/terrain-export/refresh`,
      {
        method: "POST",
        body: JSON.stringify({
          resolutionMeters: request.resolutionMeters,
          contourIntervalMeters: request.contourIntervalMeters,
        }),
        gateHeaders,
        gateContext: gateContextFromGate(gate),
      },
    );
  },

  async downloadParcelTerrainExport(
    parcelNodeId: string,
    format: TerrainExportFormat,
    gate: MapLayersAssembleGateContext,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const gateHeaders = terrainExportGateHeaders(gate);
    return engineApiFetchBytes(terrainExportDownloadPath(parcelNodeId, format), {
      gateHeaders,
      gateContext: gateContextFromGate(gate),
      timeoutMs: EXPORT_DOWNLOAD_TIMEOUT_MS,
    });
  },

  async refreshParcelSitePlanExport(
    parcelNodeId: string,
    request: SitePlanExportRefreshRequest,
    gate: MapLayersAssembleGateContext,
  ): Promise<SitePlanExportRefreshResponse> {
    const gateHeaders = sitePlanExportGateHeaders(gate);
    const encoded = encodeURIComponent(parcelNodeId);
    return engineApiFetch<SitePlanExportRefreshResponse>(
      `/v1/property-nodes/${encoded}/site-plan-export/refresh`,
      {
        method: "POST",
        body: JSON.stringify({
          resolutionMeters: request.resolutionMeters,
          contourIntervalMeters: request.contourIntervalMeters,
          address: request.address,
          countyName: request.countyName,
        }),
        gateHeaders,
        gateContext: gateContextFromGate(gate),
        // Warm refresh ~23s live; cold start exceeds the 30s default.
        timeoutMs: SITE_PLAN_REFRESH_TIMEOUT_MS,
      },
    );
  },

  async downloadParcelSitePlanExport(
    parcelNodeId: string,
    format: SitePlanExportFormat,
    gate: MapLayersAssembleGateContext,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const gateHeaders = sitePlanExportGateHeaders(gate);
    return engineApiFetchBytes(sitePlanExportDownloadPath(parcelNodeId, format), {
      gateHeaders,
      gateContext: gateContextFromGate(gate),
      timeoutMs: EXPORT_DOWNLOAD_TIMEOUT_MS,
    });
  },

  /**
   * Property-dossier refresh (engine #174). The request body is forwarded
   * VERBATIM — the engine owns validation (DOSSIER_CAPS zod) and rendering;
   * it renders exactly what the request carries and honest-degrades on
   * anything absent. Same timeout budget as the site-plan refresh: the
   * dossier reuses the site-plan model-composition path server-side, so a
   * cold refresh has the same wall-time envelope.
   */
  async refreshParcelDossierExport(
    parcelNodeId: string,
    request: DossierExportRefreshRequest,
    gate: MapLayersAssembleGateContext,
  ): Promise<DossierExportRefreshResponse> {
    const gateHeaders = dossierExportGateHeaders(gate);
    const encoded = encodeURIComponent(parcelNodeId);
    return engineApiFetch<DossierExportRefreshResponse>(
      `/v1/property-nodes/${encoded}/dossier-export/refresh`,
      {
        method: "POST",
        body: JSON.stringify(request),
        gateHeaders,
        gateContext: gateContextFromGate(gate),
        timeoutMs: SITE_PLAN_REFRESH_TIMEOUT_MS,
      },
    );
  },

  /** Property-dossier download — always the single pdf-dossier artifact. */
  async downloadParcelDossierExport(
    parcelNodeId: string,
    gate: MapLayersAssembleGateContext,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const gateHeaders = dossierExportGateHeaders(gate);
    return engineApiFetchBytes(dossierExportDownloadPath(parcelNodeId), {
      gateHeaders,
      gateContext: gateContextFromGate(gate),
      timeoutMs: EXPORT_DOWNLOAD_TIMEOUT_MS,
    });
  },

  /**
   * Property-dossier status — atom + pdf-dossier artifact metadata without
   * streaming bytes. Used by download_parcel_dossier_export to refuse hollow
   * stored artifacts (P-89 item 3) before the byte hop.
   */
  async getParcelDossierExport(
    parcelNodeId: string,
    gate: MapLayersAssembleGateContext,
  ): Promise<{
    atom: Record<string, unknown>;
    artifacts: Record<string, import("./dossier-export-contract.js").DossierExportArtifactEntry>;
  }> {
    const gateHeaders = dossierExportGateHeaders(gate);
    const encoded = encodeURIComponent(parcelNodeId);
    return engineApiFetch<{
      atom: Record<string, unknown>;
      artifacts: Record<string, import("./dossier-export-contract.js").DossierExportArtifactEntry>;
    }>(`/v1/property-nodes/${encoded}/dossier-export`, {
      method: "GET",
      gateHeaders,
      gateContext: gateContextFromGate(gate),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  },
};

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

const DEFAULT_ENGINE_API_URL = "http://localhost:8080";
const DEFAULT_TIMEOUT_MS = 30_000;

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

async function engineApiFetch<T>(
  path: string,
  init: RequestInit & {
    timeoutMs?: number;
    gateHeaders: Record<string, string>;
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

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      body: init.body,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
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
      },
    );
  },
};

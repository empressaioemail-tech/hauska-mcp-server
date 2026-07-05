// Gate-signed tenant context (Tenancy T1 producer side).
//
// Builds and signs verifiable tenant-identity contexts for upstream
// services (cortex-api, engine-api). Replaces blind-trust forwarded
// headers with HMAC-SHA256-signed, expiring contexts that upstreams
// can verify. The gate is the single place tenant identity is
// resolved; this module makes that resolution tamper-proof.
//
// Header contract:
//   X-Hauska-Gate-Context: <base64url-encoded JSON payload>
//   X-Hauska-Gate-Signature: <hex-encoded HMAC-SHA256 signature>
//
// The signature is computed over the base64url payload using the
// GATE_CONTEXT_SIGNING_KEY (HMAC-SHA256). Contexts expire 300s after
// issuance (iat + 300s).

import { createHmac, timingSafeEqual } from "node:crypto";

export interface GateContext {
  v: 1;
  tenant: string | null;
  product: string;
  tier: string;
  keyId: string | null;
  platformInternal: boolean;
  iat: number;
  exp: number;
}

export interface GateContextOpts {
  tenant: string | null;
  product: string;
  tier: string;
  keyId: string | null;
  platformInternal: boolean;
}

const CONTEXT_TTL_SECONDS = 300;

// Injectable clock for tests. Never call Date.now() directly; use this
// seam so tests can control time without monkey-patching globals.
let nowFn = (): number => Date.now();

export function setNowFn(fn: () => number): void {
  nowFn = fn;
}

export function resetNowFn(): void {
  nowFn = () => Date.now();
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64urlDecode(str: string): Buffer {
  const padded = str + "==".slice(0, (4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

function canonicalJson(obj: GateContext): string {
  // Canonical JSON serialization: deterministic key order matching the
  // GateContext shape. This ensures identical payload → identical
  // signature across producers and consumers.
  return JSON.stringify({
    v: obj.v,
    tenant: obj.tenant,
    product: obj.product,
    tier: obj.tier,
    keyId: obj.keyId,
    platformInternal: obj.platformInternal,
    iat: obj.iat,
    exp: obj.exp,
  });
}

function signPayload(payloadB64: string, key: string): string {
  const hmac = createHmac("sha256", key);
  hmac.update(payloadB64);
  return hmac.digest("hex");
}

export function buildSignedGateContext(
  opts: GateContextOpts,
  signingKey: string,
): { payload: string; signature: string } {
  const nowMs = nowFn();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + CONTEXT_TTL_SECONDS;

  const ctx: GateContext = {
    v: 1,
    tenant: opts.tenant,
    product: opts.product,
    tier: opts.tier,
    keyId: opts.keyId,
    platformInternal: opts.platformInternal,
    iat,
    exp,
  };

  const json = canonicalJson(ctx);
  const payload = base64urlEncode(Buffer.from(json, "utf8"));
  const signature = signPayload(payload, signingKey);

  return { payload, signature };
}

export class GateContextVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "GateContextVerificationError";
  }
}

export function verifySignedGateContext(
  payloadB64: string,
  signature: string,
  key: string,
  nowMs: number,
): GateContext {
  const expectedSig = signPayload(payloadB64, key);

  // Constant-time signature comparison. Both signatures are hex-encoded
  // HMAC-SHA256 outputs (64 hex chars = 32 bytes). Convert to buffers
  // and use timingSafeEqual.
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");

  if (sigBuf.length !== expectedBuf.length) {
    throw new GateContextVerificationError(
      "Signature length mismatch",
      "SIGNATURE_INVALID",
    );
  }

  if (!timingSafeEqual(sigBuf, expectedBuf)) {
    throw new GateContextVerificationError(
      "Signature verification failed",
      "SIGNATURE_INVALID",
    );
  }

  let json: string;
  try {
    json = base64urlDecode(payloadB64).toString("utf8");
  } catch {
    throw new GateContextVerificationError(
      "Invalid base64url payload",
      "PAYLOAD_MALFORMED",
    );
  }

  let ctx: unknown;
  try {
    ctx = JSON.parse(json);
  } catch {
    throw new GateContextVerificationError(
      "Payload is not valid JSON",
      "PAYLOAD_MALFORMED",
    );
  }

  if (typeof ctx !== "object" || ctx === null) {
    throw new GateContextVerificationError(
      "Payload is not a JSON object",
      "PAYLOAD_MALFORMED",
    );
  }

  const obj = ctx as Record<string, unknown>;

  if (obj.v !== 1) {
    throw new GateContextVerificationError(
      "Unsupported context version",
      "VERSION_UNSUPPORTED",
    );
  }

  if (typeof obj.iat !== "number" || typeof obj.exp !== "number") {
    throw new GateContextVerificationError(
      "Missing or invalid iat/exp timestamps",
      "PAYLOAD_MALFORMED",
    );
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec >= obj.exp) {
    throw new GateContextVerificationError(
      `Context expired at ${obj.exp}, now is ${nowSec}`,
      "CONTEXT_EXPIRED",
    );
  }

  // Type-check remaining fields. tenant and keyId can be null; the rest
  // are required strings or boolean.
  if (
    (obj.tenant !== null && typeof obj.tenant !== "string") ||
    typeof obj.product !== "string" ||
    typeof obj.tier !== "string" ||
    (obj.keyId !== null && typeof obj.keyId !== "string") ||
    typeof obj.platformInternal !== "boolean"
  ) {
    throw new GateContextVerificationError(
      "Payload field type mismatch",
      "PAYLOAD_MALFORMED",
    );
  }

  return obj as unknown as GateContext;
}

// Postgres connection plus api_keys CRUD.
//
// Schema lives at migrations/001_api_keys.sql and is shipped via
// `npm run migrate`. This module only reads and writes against the
// existing schema; it does not create tables.

import { randomUUID } from "node:crypto";

import pg from "pg";

import { isProduct, type Product } from "./products.js";
import { isTier, type Tier } from "./tiers.js";

const { Pool } = pg;

export type KeyStatus = "active" | "revoked" | "past_due" | "canceled";

export interface ApiKeyRow {
  key_id: string;
  key_hash: string;
  tier: Tier;
  product: Product;
  owner_email: string;
  owner_name: string | null;
  created_at: Date;
  last_used_at: Date | null;
  status: KeyStatus;
  notes: string | null;
}

// Public-safe projection. Never includes key_hash.
export interface ApiKeyPublic {
  key_id: string;
  tier: Tier;
  product: Product;
  owner_email: string;
  owner_name: string | null;
  created_at: string;
  last_used_at: string | null;
  status: KeyStatus;
  notes: string | null;
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Cannot initialize pg pool.");
  }
  pool = new Pool({
    connectionString,
    max: parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function rowToPublic(row: ApiKeyRow): ApiKeyPublic {
  return {
    key_id: row.key_id,
    tier: row.tier,
    product: row.product,
    owner_email: row.owner_email,
    owner_name: row.owner_name,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    status: row.status,
    notes: row.notes,
  };
}

function castRow(raw: Record<string, unknown>): ApiKeyRow {
  const tier = raw.tier;
  if (typeof tier !== "string" || !isTier(tier)) {
    throw new Error(`api_keys row has invalid tier: ${String(tier)}`);
  }
  // Pre-migration 002 rows do not carry product; default to 'public' so
  // the column-add migration can roll out without coordinated app deploy.
  const productRaw = raw.product;
  const product: Product =
    typeof productRaw === "string" && isProduct(productRaw)
      ? productRaw
      : "public";
  return {
    key_id: raw.key_id as string,
    key_hash: raw.key_hash as string,
    tier,
    product,
    owner_email: raw.owner_email as string,
    owner_name: (raw.owner_name as string | null) ?? null,
    created_at: raw.created_at as Date,
    last_used_at: (raw.last_used_at as Date | null) ?? null,
    status: raw.status as KeyStatus,
    notes: (raw.notes as string | null) ?? null,
  };
}

const SELECT_COLS =
  "key_id, key_hash, tier, product, owner_email, owner_name, created_at, last_used_at, status, notes";

export async function insertKey(params: {
  key_hash: string;
  tier: Tier;
  product: Product;
  owner_email: string;
  owner_name?: string | null;
  notes?: string | null;
}): Promise<ApiKeyPublic> {
  const keyId = randomUUID();
  const result = await getPool().query<Record<string, unknown>>(
    `INSERT INTO api_keys (key_id, key_hash, tier, product, owner_email, owner_name, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT_COLS}`,
    [
      keyId,
      params.key_hash,
      params.tier,
      params.product,
      params.owner_email,
      params.owner_name ?? null,
      params.notes ?? null,
    ],
  );
  if (!result.rows[0]) {
    throw new Error("insertKey: INSERT returned no row.");
  }
  return rowToPublic(castRow(result.rows[0]));
}

export async function findKeyByHash(
  hash: string,
): Promise<ApiKeyRow | null> {
  const result = await getPool().query<Record<string, unknown>>(
    `SELECT ${SELECT_COLS}
     FROM api_keys
     WHERE key_hash = $1`,
    [hash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return castRow(row);
}

export async function listKeys(): Promise<ApiKeyPublic[]> {
  const result = await getPool().query<Record<string, unknown>>(
    `SELECT ${SELECT_COLS}
     FROM api_keys
     ORDER BY created_at DESC`,
  );
  return result.rows.map((r) => rowToPublic(castRow(r)));
}

export async function updateKey(
  keyId: string,
  patch: {
    tier?: Tier;
    product?: Product;
    status?: KeyStatus;
    notes?: string | null;
  },
): Promise<ApiKeyPublic | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (patch.tier !== undefined) {
    sets.push(`tier = $${i++}`);
    values.push(patch.tier);
  }
  if (patch.product !== undefined) {
    sets.push(`product = $${i++}`);
    values.push(patch.product);
  }
  if (patch.status !== undefined) {
    sets.push(`status = $${i++}`);
    values.push(patch.status);
  }
  if (patch.notes !== undefined) {
    sets.push(`notes = $${i++}`);
    values.push(patch.notes);
  }
  if (sets.length === 0) {
    // No-op patch: just return the current row.
    const result = await getPool().query<Record<string, unknown>>(
      `SELECT ${SELECT_COLS}
       FROM api_keys
       WHERE key_id = $1`,
      [keyId],
    );
    const row = result.rows[0];
    return row ? rowToPublic(castRow(row)) : null;
  }
  values.push(keyId);
  const result = await getPool().query<Record<string, unknown>>(
    `UPDATE api_keys
     SET ${sets.join(", ")}
     WHERE key_id = $${i}
     RETURNING ${SELECT_COLS}`,
    values,
  );
  const row = result.rows[0];
  return row ? rowToPublic(castRow(row)) : null;
}

export async function revokeKey(keyId: string): Promise<ApiKeyPublic | null> {
  return updateKey(keyId, { status: "revoked" });
}

// Fire-and-forget last_used update. Errors are swallowed; the auth path
// must not fail because of a stale-stat write.
export function touchLastUsed(keyId: string): void {
  getPool()
    .query("UPDATE api_keys SET last_used_at = NOW() WHERE key_id = $1", [
      keyId,
    ])
    .catch(() => {
      // Swallow. Logged elsewhere if it becomes a pattern.
    });
}

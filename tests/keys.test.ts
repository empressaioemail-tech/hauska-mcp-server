// Key generation, hashing, and parsing conformance tests.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { constantTimeEquals, generateKey, hashKey, parseKey } from "../src/keys.js";
import { TIERS } from "../src/tiers.js";

test("generateKey produces a hk_<prefix>_<43-char> wire shape per tier", () => {
  for (const tier of TIERS) {
    const k = generateKey(tier);
    assert.equal(k.tier, tier);
    assert.match(k.raw, /^hk_(free|pro|team|emb)_[A-Za-z0-9_-]{43}$/);
    assert.equal(k.hash, hashKey(k.raw));
    assert.equal(k.hash.length, 64); // SHA-256 hex.
  }
});

test("generateKey produces unique raw and hash across many invocations", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 256; i++) {
    const k = generateKey("developer_pro");
    assert.ok(!seen.has(k.raw), "duplicate raw key generated");
    assert.ok(!seen.has(k.hash), "duplicate hash generated");
    seen.add(k.raw);
    seen.add(k.hash);
  }
});

test("hashKey is deterministic", () => {
  const k = generateKey("team");
  assert.equal(hashKey(k.raw), hashKey(k.raw));
  assert.equal(hashKey(k.raw), k.hash);
});

test("parseKey returns tier + hash for a valid key", () => {
  for (const tier of TIERS) {
    const k = generateKey(tier);
    const parsed = parseKey(k.raw);
    assert.ok(parsed, `parseKey returned null for valid ${tier} key`);
    assert.equal(parsed!.tier, tier);
    assert.equal(parsed!.hash, k.hash);
  }
});

test("parseKey rejects garbage", () => {
  const bad = [
    "",
    "hk_free_",
    "hk_free_short",
    "hk_xxx_" + "A".repeat(43),
    "not-a-key",
    "hk_pro_" + "!".repeat(43),
    "hk_pro_" + "A".repeat(42), // too short
    "hk_pro_" + "A".repeat(44), // too long
  ];
  for (const b of bad) {
    assert.equal(parseKey(b), null, `should reject: ${b}`);
  }
});

test("constantTimeEquals only matches identical-length identical strings", () => {
  assert.equal(constantTimeEquals("abc", "abc"), true);
  assert.equal(constantTimeEquals("abc", "abd"), false);
  assert.equal(constantTimeEquals("abc", "abcd"), false);
  assert.equal(constantTimeEquals("", ""), true);
});

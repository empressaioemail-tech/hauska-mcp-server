// Cross-repo drift guard: MCP parcel-keyed types must match engine PROPERTY_ENTITY_TYPES.

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH,
  PARCEL_KEYED_PROPERTY_ENTITY_TYPES,
  deriveParcelKeyedPropertyEntityTypes,
  parsePropertyEntityTypesFromEngineSource,
} from "../src/property-entity-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures/engine-property-instances.snapshot.ts");

function engineSourcePath(): string {
  const fromEnv = process.env.HAUSKA_ENGINE_PROPERTY_INSTANCES_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH)) {
    return DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH;
  }
  const sibling = join(__dirname, "../../../hauska-engine/packages/atoms/src/property-instances.ts");
  if (existsSync(sibling)) return sibling;
  if (existsSync(FIXTURE_PATH)) return FIXTURE_PATH;
  throw new Error(
    "Engine property-instances.ts not found; set HAUSKA_ENGINE_PROPERTY_INSTANCES_PATH or refresh tests/fixtures/engine-property-instances.snapshot.ts",
  );
}

function loadEngineTypes(): string[] {
  return parsePropertyEntityTypesFromEngineSource(
    readFileSync(engineSourcePath(), "utf8"),
  );
}

test("MCP parcel-keyed set matches engine PROPERTY_ENTITY_TYPES minus road-node", () => {
  const engineTypes = loadEngineTypes();
  const expected = deriveParcelKeyedPropertyEntityTypes(engineTypes);
  assert.deepEqual(
    [...PARCEL_KEYED_PROPERTY_ENTITY_TYPES],
    [...expected],
    "Update ENGINE_PROPERTY_ENTITY_TYPES_MIRROR in property-entity-types.ts when engine adds types",
  );
  assert.equal(expected.length, 15);
  assert.ok(!expected.includes("road-node"));
});

test("drift guard fails when a fake engine type is injected (negative fixture)", () => {
  const engineTypes = loadEngineTypes();
  const poisoned = [...engineTypes, "synthetic-not-a-real-type"];
  const expectedPoisoned = deriveParcelKeyedPropertyEntityTypes(poisoned);
  assert.notDeepEqual(
    [...PARCEL_KEYED_PROPERTY_ENTITY_TYPES],
    [...expectedPoisoned],
    "fixture must diverge when engine list is poisoned",
  );
});

test("parsePropertyEntityTypesFromEngineSource rejects malformed source", () => {
  assert.throws(() => parsePropertyEntityTypesFromEngineSource("// no array here"));
});

test("committed engine snapshot stays aligned when sibling engine checkout exists", () => {
  const liveCandidates = [
    process.env.HAUSKA_ENGINE_PROPERTY_INSTANCES_PATH,
    DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH,
    join(__dirname, "../../../hauska-engine/packages/atoms/src/property-instances.ts"),
  ].filter((p): p is string => typeof p === "string" && existsSync(p));
  if (liveCandidates.length === 0) {
    return;
  }
  const live = parsePropertyEntityTypesFromEngineSource(
    readFileSync(liveCandidates[0]!, "utf8"),
  );
  const fixture = parsePropertyEntityTypesFromEngineSource(
    readFileSync(FIXTURE_PATH, "utf8"),
  );
  assert.deepEqual(fixture, live, "Refresh tests/fixtures/engine-property-instances.snapshot.ts from engine");
});

// Cross-repo drift guard: MCP parcel-keyed types must match engine PROPERTY_ENTITY_TYPES.

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH,
  PARCEL_KEYED_PROPERTY_ENTITY_TYPES,
  deriveParcelKeyedPropertyEntityTypes,
  loadPropertyEntityTypesFromEngineFile,
  parsePropertyEntityTypesFromEngineSource,
} from "../src/property-entity-types.js";

function engineSourcePath(): string {
  const fromEnv = process.env.HAUSKA_ENGINE_PROPERTY_INSTANCES_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH)) {
    return DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH;
  }
  throw new Error(
    `Engine property-instances.ts not found (set HAUSKA_ENGINE_PROPERTY_INSTANCES_PATH). Tried: ${DEFAULT_ENGINE_PROPERTY_INSTANCES_PATH}`,
  );
}

test("MCP parcel-keyed set matches engine PROPERTY_ENTITY_TYPES minus road-node", () => {
  const engineTypes = loadPropertyEntityTypesFromEngineFile(engineSourcePath());
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
  const engineTypes = loadPropertyEntityTypesFromEngineFile(engineSourcePath());
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

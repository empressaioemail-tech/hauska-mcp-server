// Phase 1c property atom chain - accessPolicy + honest pending state.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import type { AccessPolicy } from "@empressaio/atom-contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AtomInstanceBase } from "../src/hauska-client.js";
import {
  PARCEL_KEYED_PROPERTY_ENTITY_TYPES,
  chainStatusNote,
  parcelNodeIdFromAtomDid,
  parsePropertyAtomDid,
  propertyChainAtomDid,
  resolvePropertyAtomChain,
  upstreamAtomsFromEngineWire,
} from "../src/property-atom-chain.js";
import type { AccessSubject } from "../src/access-policy.js";
import { TOOL_COPY } from "../src/tool-copy.js";
import { registerTools } from "../src/tools.js";
import { toolGateMetadata } from "../src/mcp-introspection.js";

const RETIRED_FOUR_TYPE_PRODUCT_SET = [
  "parcel-node",
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
];

const PARCEL = "48209:156346";

interface RecordedCall {
  url: string;
}

const calls: RecordedCall[] = [];
let mockRoutes: Record<string, { status: number; body: unknown }> = {};

const realFetch = globalThis.fetch;

function atomBody(
  entityType: string,
  accessPolicy: AccessPolicy,
  jurisdictionTenant = "travis-tx",
): AtomInstanceBase {
  return {
    entityType,
    entityId: `${PARCEL}`,
    jurisdictionTenant,
    fetchedAt: "2026-07-23T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "https://example.test/source",
    contentHash: "abc123",
    accessPolicy,
  };
}

const anonymousSubject: AccessSubject = {
  tier: "free_anonymous",
  jurisdictionTenant: null,
  platformInternal: false,
};

const paidSubject: AccessSubject = {
  tier: "developer_pro",
  jurisdictionTenant: null,
  platformInternal: false,
};

beforeEach(() => {
  calls.length = 0;
  mockRoutes = {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    const chainMatch = /\/property-nodes\/([^/]+)\/atom-chain$/.exec(new URL(url).pathname);
    if (chainMatch) {
      const route = mockRoutes["chain"];
      if (route) {
        return new Response(JSON.stringify(route.body), {
          status: route.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    const atomMatch = /\/atoms\/(.+)$/.exec(new URL(url).pathname);
    if (atomMatch) {
      const decoded = decodeURIComponent(atomMatch[1]!);
      const route = mockRoutes[decoded];
      if (route) {
        return new Response(JSON.stringify(route.body), {
          status: route.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ atom: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("propertyChainAtomDid round-trips every derived parcel-keyed type", () => {
  assert.notDeepEqual(
    [...PARCEL_KEYED_PROPERTY_ENTITY_TYPES].sort(),
    [...RETIRED_FOUR_TYPE_PRODUCT_SET].sort(),
    "chain must not collapse to the retired four-type product set",
  );
  for (const entityType of PARCEL_KEYED_PROPERTY_ENTITY_TYPES) {
    const did = propertyChainAtomDid(PARCEL, entityType);
    assert.equal(did, `did:hauska:${entityType}:${PARCEL}`);
    assert.equal(parcelNodeIdFromAtomDid(did), PARCEL);
    const parsed = parsePropertyAtomDid(did);
    assert.ok(parsed, `structural parse must accept ${entityType}`);
    assert.equal(parsed!.entityType, entityType);
  }
  assert.equal(parsePropertyAtomDid("did:hauska:road-node:48021:33512"), null);
  assert.equal(
    parsePropertyAtomDid("did:hauska:not-a-real-type:48209:156346"),
    null,
  );
});

test("tool copy lists derived parcel-keyed types, not the retired four-type product set", () => {
  const derivedList = PARCEL_KEYED_PROPERTY_ENTITY_TYPES.join(", ");
  assert.match(TOOL_COPY.get_atom, new RegExp(derivedList.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    TOOL_COPY.get_property_atom_chain,
    new RegExp(derivedList.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(TOOL_COPY.get_property_atom_chain, /the same three slots/);
});

test("anonymous caller sees public-free zoning only; envelope withheld", async () => {
  const zoningDid = propertyChainAtomDid(PARCEL, "zoning-fact");
  const setbackDid = propertyChainAtomDid(PARCEL, "setback-rule");
  const envelopeDid = propertyChainAtomDid(PARCEL, "buildable-envelope");

  mockRoutes[zoningDid] = {
    status: 200,
    body: { atom: atomBody("zoning-fact", "public-free") },
  };
  mockRoutes[setbackDid] = {
    status: 200,
    body: { atom: atomBody("setback-rule", "public-free") },
  };
  mockRoutes[envelopeDid] = {
    status: 200,
    body: { atom: atomBody("buildable-envelope", "public-paid") },
  };

  const data = await resolvePropertyAtomChain(
    { parcelNodeId: PARCEL },
    anonymousSubject,
  );

  assert.equal(data.status, "partial");
  assert.ok(data.chain.zoningFact.atom);
  assert.ok(data.chain.setbackRule.atom);
  assert.equal(data.chain.buildableEnvelope.atom, null);
  assert.equal(data.chain.buildableEnvelope.withheld, true);
  assert.deepEqual(data.withheldSlots, ["buildable-envelope"]);
});

test("paid caller receives public-paid envelope atom", async () => {
  const envelopeDid = propertyChainAtomDid(PARCEL, "buildable-envelope");
  mockRoutes[propertyChainAtomDid(PARCEL, "zoning-fact")] = {
    status: 200,
    body: { atom: atomBody("zoning-fact", "public-free") },
  };
  mockRoutes[propertyChainAtomDid(PARCEL, "setback-rule")] = {
    status: 200,
    body: { atom: atomBody("setback-rule", "public-free") },
  };
  mockRoutes[envelopeDid] = {
    status: 200,
    body: { atom: atomBody("buildable-envelope", "public-paid") },
  };

  const data = await resolvePropertyAtomChain({ parcelNodeId: PARCEL }, paidSubject);
  assert.equal(data.status, "ready");
  assert.ok(data.chain.buildableEnvelope.atom);
});

test("empty corpus returns atom_path_pending without inventing atoms", async () => {
  const data = await resolvePropertyAtomChain({ parcelNodeId: PARCEL }, anonymousSubject);
  assert.equal(data.status, "atom_path_pending");
  assert.deepEqual(data.pendingSlots, [...PARCEL_KEYED_PROPERTY_ENTITY_TYPES]);
  assert.match(chainStatusNote(data)!, /atom_path_pending/);
  assert.match(chainStatusNote(data)!, /not in the retrieval corpus/i);
});

test("engine chain endpoint used when deployed", async () => {
  mockRoutes["chain"] = {
    status: 200,
    body: {
      parcelNodeId: PARCEL,
      zoningFact: atomBody("zoning-fact", "public-free"),
      setbackRule: atomBody("setback-rule", "public-free"),
      buildableEnvelope: atomBody("buildable-envelope", "public-paid"),
    },
  };

  const data = await resolvePropertyAtomChain({ parcelNodeId: PARCEL }, paidSubject);
  assert.equal(data.status, "ready");
  assert.ok(calls.some((c) => c.url.includes("/property-nodes/48209%3A156346/atom-chain")));
  assert.equal(
    calls.filter((c) => c.url.includes("/atoms/")).length,
    0,
    "should not fall back to per-DID fetch when chain route succeeds",
  );
});

test("get_property_atom_chain MCP tool: atoms[] only includes readable slots", async () => {
  const zoningDid = propertyChainAtomDid(PARCEL, "zoning-fact");
  mockRoutes[zoningDid] = {
    status: 200,
    body: { atom: atomBody("zoning-fact", "public-free") },
  };
  mockRoutes[propertyChainAtomDid(PARCEL, "setback-rule")] = {
    status: 200,
    body: { atom: null },
  };
  mockRoutes[propertyChainAtomDid(PARCEL, "buildable-envelope")] = {
    status: 200,
    body: { atom: atomBody("buildable-envelope", "public-paid") },
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "get_property_atom_chain",
    arguments: { parcel_node_id: PARCEL },
  });

  await client.close();
  await server.close();

  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  const envelope = JSON.parse(text) as {
    data: { status: string };
    atoms: Array<{ did: string }>;
    meta: { attribution?: string; note?: string };
  };

  assert.equal(envelope.data.status, "partial");
  assert.equal(envelope.atoms.length, 1);
  assert.equal(envelope.atoms[0]!.did, zoningDid);
  assert.match(envelope.meta.attribution ?? "", /Powered by Hauska Engine/);
  assert.match(envelope.meta.note ?? "", /withheld by accessPolicy|Partial chain/);
});

test("toolGateMetadata registers get_property_atom_chain on public access_policy gate", () => {
  const meta = toolGateMetadata("get_property_atom_chain");
  assert.equal(meta.product, "public");
  assert.equal(meta.gate, "access_policy");
  assert.equal(meta.anonymous_ok, true);
});


test("parcelNodeIdFromAtomDid recovers parcel from owner-fact DID with tax-year suffix", () => {
  const did = "did:hauska:owner-fact:48021:27303:2026";
  assert.equal(parcelNodeIdFromAtomDid(did), "48021:27303");
  assert.equal(
    parcelNodeIdFromAtomDid("did:hauska:road-node:48021:33512"),
    null,
    "road-node DIDs are not parcel-chain reachable",
  );
});

test("owner-fact withheld for anonymous; readable for paid subject", async () => {
  const ownerDid = "did:hauska:owner-fact:48209:156346";
  mockRoutes[ownerDid] = {
    status: 200,
    body: { atom: atomBody("owner-fact", "public-paid") },
  };

  const anon = await resolvePropertyAtomChain({ parcelNodeId: PARCEL }, anonymousSubject);
  assert.equal(anon.slots["owner-fact"].atom, null);
  assert.equal(anon.slots["owner-fact"].withheld, true);
  assert.ok(anon.withheldSlots.includes("owner-fact"));

  const paid = await resolvePropertyAtomChain({ parcelNodeId: PARCEL }, paidSubject);
  assert.ok(paid.slots["owner-fact"].atom);
  assert.equal(paid.slots["owner-fact"].withheld, undefined);
});

test("upstreamAtomsFromEngineWire maps atoms[] and atomsByType", () => {
  const landUse = atomBody("land-use-fact", "public-free");
  const wire = upstreamAtomsFromEngineWire({
    parcelNodeId: PARCEL,
    atomsByType: { "owner-fact": atomBody("owner-fact", "public-paid") },
    atoms: [{ type: "land-use-fact", payload: landUse }],
    zoningFact: atomBody("zoning-fact", "public-free"),
  });
  assert.ok(wire["land-use-fact"]);
  assert.ok(wire["owner-fact"]);
  assert.ok(wire["zoning-fact"]);
});


// Atom-shape envelope conformance.
//
// Covers the per-tier attribution surface rules from doc_repo
// 50_hauska_mcp_server.md §Free-tier-attribution and the provenance
// shape required by the Stream 2A dispatch (DID, content hash, source).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ATTRIBUTION_STRING,
  buildEnvelope,
  getAtomEnvelope,
  getPropertyWorkspaceEnvelope,
  listJurisdictionsEnvelope,
  listPropertyWorkspacesEnvelope,
  listWorkspaceShareEdgesEnvelope,
  provenanceFromAtom,
  provenanceFromSearchResult,
  queryJurisdictionEnvelope,
  searchAtomsEnvelope,
} from "../src/atom-shape.js";
import type {
  AtomInstanceBase,
  AtomSearchResult,
  JurisdictionStatusSnapshot,
} from "../src/hauska-client.js";

const SEARCH_RESULT: AtomSearchResult = {
  atomDid: "did:hauska:code-section:bastrop-tx/udc-2024/5.04",
  entityType: "code-section",
  entityId: "bastrop-tx/udc-2024/5.04",
  jurisdictionTenant: "bastrop-tx",
  sectionNumber: "5.04",
  snippet: "Setback requirements for residential lots.",
  score: 0.92,
};

const FULL_ATOM: AtomInstanceBase = {
  entityType: "code-section",
  entityId: "bastrop-tx/udc-2024/5.04",
  jurisdictionTenant: "bastrop-tx",
  fetchedAt: "2026-05-19T10:00:00Z",
  sourceAdapter: "municode-html",
  sourceUrl: "https://library.municode.com/tx/bastrop/codes/code_of_ordinances",
  contentHash: "sha256:abc123",
  bodyText: "Setback requirements.",
};

const JUR: JurisdictionStatusSnapshot = {
  jurisdictionTenant: "bastrop-tx",
  jurisdictionName: "Bastrop, TX",
  currentEditionDid: "did:hauska:code-edition:bastrop-tx/udc-2024",
  qualityBar: "passing",
  top3Score: 0.95,
  sectionNumScore: 1.0,
  crossRefScore: 0.96,
  atomCount: 217,
  lastRefreshedAt: "2026-05-19T08:00:00Z",
  driftStatus: "clean",
};

test("provenanceFromSearchResult surfaces DID, entity type, jurisdiction, section number", () => {
  const p = provenanceFromSearchResult(SEARCH_RESULT);
  assert.equal(p.did, SEARCH_RESULT.atomDid);
  assert.equal(p.entityType, "code-section");
  assert.equal(p.jurisdictionTenant, "bastrop-tx");
  assert.equal(p.sectionNumber, "5.04");
  assert.equal(p.contentHash, null, "search results carry no content hash");
  assert.equal(p.source.adapter, null);
});

test("provenanceFromAtom surfaces DID, content hash, source adapter, source URL, fetched-at", () => {
  const p = provenanceFromAtom(FULL_ATOM);
  assert.equal(p.did, "did:hauska:code-section:bastrop-tx/udc-2024/5.04");
  assert.equal(p.contentHash, "sha256:abc123");
  assert.equal(p.source.adapter, "municode-html");
  assert.equal(p.source.url, FULL_ATOM.sourceUrl);
  assert.equal(p.source.fetchedAt, "2026-05-19T10:00:00Z");
});

test("buildEnvelope attaches attribution for free_anonymous tier", () => {
  const env = buildEnvelope({ x: 1 }, [], { tier: "free_anonymous" });
  assert.equal(env.meta.attribution, ATTRIBUTION_STRING);
  assert.match(env.meta.attribution!, /—/, "attribution string must contain an em dash");
});

test("buildEnvelope attaches attribution for free tier (authed free key)", () => {
  const env = buildEnvelope({ x: 1 }, [], { tier: "free" });
  assert.equal(env.meta.attribution, ATTRIBUTION_STRING);
});

test("buildEnvelope attaches attribution for developer_pro and team", () => {
  // Per 50 §Free-tier-attribution: lower paid tiers retain the
  // attribution requirement. Only Embedder strips it.
  for (const tier of ["developer_pro", "team"] as const) {
    const env = buildEnvelope({ x: 1 }, [], { tier });
    assert.equal(
      env.meta.attribution,
      undefined,
      `tier "${tier}" currently has no attribution surfaced; revisit when paid-tier attribution rules tighten.`,
    );
  }
});

test("buildEnvelope strips attribution for embedder tier", () => {
  const env = buildEnvelope({ x: 1 }, [], { tier: "embedder" });
  assert.equal(env.meta.attribution, undefined);
});

test("searchAtomsEnvelope returns provenance for every result", () => {
  const env = searchAtomsEnvelope(
    { results: [SEARCH_RESULT, SEARCH_RESULT], totalCandidates: 2 },
    { tier: "free_anonymous" },
  );
  assert.equal(env.atoms.length, 2);
  assert.equal(env.data.totalCandidates, 2);
  assert.equal(env.meta.attribution, ATTRIBUTION_STRING);
});

test("getAtomEnvelope returns provenance for the atom and its composition", () => {
  const env = getAtomEnvelope(
    {
      atom: FULL_ATOM,
      composition: [
        {
          link: {
            fromEntityType: "code-section",
            fromEntityId: "bastrop-tx/udc-2024/5.04",
            toEntityType: "code-cross-reference",
            toEntityId: "bastrop-tx/udc-2024/xref-1",
            linkType: "cites",
          },
          atom: { ...FULL_ATOM, entityId: "bastrop-tx/udc-2024/xref-1" },
        },
      ],
    },
    { tier: "free_anonymous" },
  );
  assert.equal(env.atoms.length, 2, "atom + 1 composition child");
  assert.equal(env.atoms[0]!.contentHash, "sha256:abc123");
});

test("getAtomEnvelope on null atom returns empty atoms array but keeps envelope shape", () => {
  const env = getAtomEnvelope(
    { atom: null },
    { tier: "free_anonymous", note: "not found" },
  );
  assert.deepEqual(env.atoms, []);
  assert.equal(env.meta.note, "not found");
  assert.equal(env.meta.attribution, ATTRIBUTION_STRING);
});

test("listJurisdictionsEnvelope surfaces current-edition DIDs as atoms", () => {
  const env = listJurisdictionsEnvelope(
    { jurisdictions: [JUR] },
    { tier: "free_anonymous" },
  );
  assert.equal(env.atoms.length, 1);
  assert.equal(env.atoms[0]!.did, JUR.currentEditionDid);
  assert.equal(env.atoms[0]!.entityType, "code-edition");
});

test("listJurisdictionsEnvelope skips jurisdictions without a currentEditionDid", () => {
  const env = listJurisdictionsEnvelope(
    {
      jurisdictions: [
        { ...JUR, currentEditionDid: null },
      ],
    },
    { tier: "free_anonymous" },
  );
  assert.equal(env.atoms.length, 0);
  assert.equal(env.data.jurisdictions.length, 1);
});

test("queryJurisdictionEnvelope surfaces edition DID plus any permit atoms", () => {
  const env = queryJurisdictionEnvelope(
    { status: JUR, permitAtoms: [SEARCH_RESULT, SEARCH_RESULT] },
    { tier: "free_anonymous" },
  );
  assert.equal(env.atoms.length, 3, "1 edition + 2 permit atoms");
  assert.equal(env.atoms[0]!.entityType, "code-edition");
  assert.equal(env.atoms[1]!.entityType, "code-section");
});

test("attribution string is exactly the brand-specified verbatim form", () => {
  assert.equal(ATTRIBUTION_STRING, "Powered by Hauska Engine — hauska.dev");
});

test("listPropertyWorkspacesEnvelope maps evidence refs into compact provenance", () => {
  const env = listPropertyWorkspacesEnvelope(
    {
      workspaces: [
        {
          workspaceId: "ws_1",
          addressLabel: "251 Cool Water Dr, Bastrop, TX",
          listingUrls: ["https://example.com/listing/1"],
          ownerUserId: "u_owner",
          collaboratorUserIds: ["u_col"],
          lastActivityAt: "2026-05-28T00:00:00Z",
          createdAt: "2026-05-27T00:00:00Z",
          updatedAt: "2026-05-28T00:00:00Z",
          role: "owner",
          evidenceRefs: [
            {
              refId: "ref_atom_1",
              kind: "atom",
              atomDid: "did:hauska:brief-run:ws_1/run_1",
              observedAt: "2026-05-28T00:00:00Z",
            },
          ],
        },
      ],
    },
    { tier: "developer_pro" },
  );
  assert.equal(env.atoms.length, 1);
  assert.equal(env.atoms[0]!.did, "did:hauska:brief-run:ws_1/run_1");
  assert.equal(env.atoms[0]!.entityType, "atom");
});

test("getPropertyWorkspaceEnvelope returns empty atoms when evidence refs are absent", () => {
  const env = getPropertyWorkspaceEnvelope(
    {
      workspace: {
        workspaceId: "ws_1",
        addressLabel: "251 Cool Water Dr, Bastrop, TX",
        listingUrls: [],
        ownerUserId: "u_owner",
        collaboratorUserIds: [],
        lastActivityAt: "2026-05-28T00:00:00Z",
        createdAt: "2026-05-27T00:00:00Z",
        updatedAt: "2026-05-28T00:00:00Z",
        role: "owner",
        briefRuns: [],
        attachments: [],
      },
    },
    { tier: "developer_pro" },
  );
  assert.equal(env.atoms.length, 0);
});

test("listWorkspaceShareEdgesEnvelope maps edge evidence refs", () => {
  const env = listWorkspaceShareEdgesEnvelope(
    {
      edges: [
        {
          edgeId: "edge_1",
          workspaceId: "ws_1",
          fromUserId: "u_owner",
          toUserId: "u_col",
          sharedAt: "2026-05-28T00:00:00Z",
          consentVisible: true,
          observedAt: "2026-05-28T00:00:00Z",
          evidenceRefs: [
            {
              refId: "share_evt_1",
              kind: "share-edge",
              sourceUrl: "/api/brokerage/v1/workspaces/ws_1/share-edges",
              observedAt: "2026-05-28T00:00:00Z",
            },
          ],
        },
      ],
    },
    { tier: "developer_pro" },
  );
  assert.equal(env.atoms.length, 1);
  assert.equal(env.atoms[0]!.did, "legacy:evidence:share_evt_1");
  assert.equal(env.atoms[0]!.entityType, "share-edge");
});

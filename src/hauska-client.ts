// Hauska Client.
//
// This file defines the interface between the MCP server and the Hauska
// atom query backend. It is currently a mocked stub that returns example
// data. Nick replaces these implementations with real calls to the
// existing query layer that Cortex and Codex already use.
//
// DO NOT duplicate query logic in the MCP server. The MCP server is a thin
// agent-facing interface. All retrieval and reasoning lives in the backend.

const BACKEND_URL = process.env.HAUSKA_BACKEND_URL ?? "http://localhost:4000";
const BACKEND_KEY = process.env.HAUSKA_BACKEND_API_KEY ?? "";

// ---------------------------------------------------------------
// Types. Match the atom model from the architecture documents.
// ---------------------------------------------------------------

export interface Atom {
  id: string;
  jurisdiction: string;
  type: string;
  title: string;
  content: string;
  source: {
    document: string;
    section: string;
    page?: number;
  };
  provenance: {
    hash: string;
    ingested_at: string;
    version: string;
  };
}

export interface AtomReference {
  id: string;
  title: string;
  jurisdiction: string;
  relevance_score: number;
  snippet: string;
}

export interface JurisdictionSummary {
  id: string;
  name: string;
  state: string;
  ingested_at: string;
  atom_count: number;
  version: string;
}

// ---------------------------------------------------------------
// Client interface. Replace each method body with real backend calls.
// ---------------------------------------------------------------

export const hauskaClient = {
  async searchAtoms(params: {
    query: string;
    jurisdiction?: string;
    limit?: number;
  }): Promise<{ atoms: AtomReference[]; query: string; total: number }> {
    // TODO: Nick. Replace with real call to the backend search endpoint.
    // const response = await fetch(`${BACKEND_URL}/search`, { ... });
    // return await response.json();

    return {
      query: params.query,
      total: 0,
      atoms: [
        {
          id: "atom_bastrop_001",
          title: "Example atom (mocked response).",
          jurisdiction: params.jurisdiction ?? "bastrop-tx",
          relevance_score: 0.92,
          snippet:
            "This is a mocked atom reference. Replace hauskaClient.searchAtoms with a real backend call.",
        },
      ],
    };
  },

  async getAtom(params: {
    atom_id: string;
    include_composition?: boolean;
  }): Promise<{ atom: Atom; composed_of?: AtomReference[]; composes?: AtomReference[] }> {
    // TODO: Nick. Replace with real call.
    return {
      atom: {
        id: params.atom_id,
        jurisdiction: "bastrop-tx",
        type: "code_section",
        title: "Mocked atom.",
        content: "This is mocked content. Wire this to the real backend.",
        source: {
          document: "Bastrop Municipal Code",
          section: "§ 0.0.0",
        },
        provenance: {
          hash: "sha256:mocked",
          ingested_at: new Date().toISOString(),
          version: "v0",
        },
      },
    };
  },

  async queryJurisdiction(params: {
    jurisdiction: string;
    parcel_id?: string;
    address?: string;
    query_type?: string;
  }): Promise<{
    jurisdiction: string;
    parcel?: { id: string; address: string };
    results: Record<string, unknown>;
    citations: AtomReference[];
  }> {
    // TODO: Nick. Replace with real call.
    return {
      jurisdiction: params.jurisdiction,
      parcel: params.parcel_id
        ? { id: params.parcel_id, address: params.address ?? "unknown" }
        : undefined,
      results: {
        note: "Mocked response. Wire this to the real backend.",
        query_type: params.query_type ?? "all",
      },
      citations: [],
    };
  },

  async getPermitRequirements(params: {
    jurisdiction: string;
    project_type: string;
    parcel_id?: string;
  }): Promise<{
    jurisdiction: string;
    project_type: string;
    requirements: Array<{
      name: string;
      description: string;
      department: string;
      sequence_order: number;
      citation: AtomReference;
    }>;
  }> {
    // TODO: Nick. Replace with real call.
    return {
      jurisdiction: params.jurisdiction,
      project_type: params.project_type,
      requirements: [
        {
          name: "Mocked permit requirement",
          description: "Wire this to the real backend.",
          department: "Planning",
          sequence_order: 1,
          citation: {
            id: "atom_mocked",
            title: "Mocked citation",
            jurisdiction: params.jurisdiction,
            relevance_score: 1.0,
            snippet: "Mocked.",
          },
        },
      ],
    };
  },

  async listJurisdictions(): Promise<{ jurisdictions: JurisdictionSummary[] }> {
    // TODO: Nick. Replace with real call.
    return {
      jurisdictions: [
        {
          id: "bastrop-tx",
          name: "Bastrop, TX",
          state: "TX",
          ingested_at: "2026-01-15T00:00:00Z",
          atom_count: 0,
          version: "v1",
        },
      ],
    };
  },
};

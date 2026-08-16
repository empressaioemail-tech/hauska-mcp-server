/**
 * Smart Files MCP tools (G-56). Reporting gate; accessPolicy at tools layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  canReadAccessTarget,
  effectiveAccessPolicy,
  logAccessDenied,
} from "./access-policy.js";
import { buildEnvelope } from "./atom-shape.js";
import type { EnforcedAccessPolicy } from "./access-policy.js";
import { LegacyHttpError } from "./legacy-client.js";
import { getCurrentAccessSubject, getCurrentProduct, getCurrentTier } from "./request-context.js";
import { smartFilesClient } from "./smart-files-client.js";
import { REPORTING_TIER, TOOL_COPY } from "./tool-copy.js";

function envelopeContent(envelope: ReturnType<typeof buildEnvelope>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
}

function errorContent(msg: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function describeLegacyFailure(tool: string, err: unknown): string {
  if (err instanceof LegacyHttpError) {
    if (err.status === 401 || err.status === 403) {
      return `${tool}: access denied (HTTP ${err.status}). ${err.body}`;
    }
    return `${tool}: legacy backend HTTP ${err.status}: ${err.body}`;
  }
  return `${tool}: ${String(err)}`;
}

function policyTarget(accessPolicy: string, scopeType: string, scopeId: string) {
  return {
    accessPolicy: accessPolicy as EnforcedAccessPolicy,
    jurisdictionTenant: scopeType === "jurisdiction" ? scopeId : "",
  };
}

async function requireFilesCaller(tool: string) {
  const product = getCurrentProduct();
  if (product !== "reporting" && product !== "codex") {
    return {
      ok: false as const,
      content: errorContent(
        `${tool} requires a reporting or Codex API key (got product "${product}"). Anonymous callers are refused.`,
      ),
    };
  }
  return { ok: true as const };
}

export function registerSmartFilesTools(server: McpServer): void {
  server.tool(
    "list_smart_file_folders",
    TOOL_COPY.list_smart_file_folders,
    {
      scopeType: z.enum(["jurisdiction", "tenant", "site"]),
      scopeId: z.string().min(1),
    },
    async ({ scopeType, scopeId }) => {
      const gate = await requireFilesCaller("list_smart_file_folders");
      if (!gate.ok) return gate.content;
      try {
        const data = await smartFilesClient.listFolders(scopeType, scopeId);
        const subject = getCurrentAccessSubject();
        const folders = data.folders.filter((f) => {
          const ok = canReadAccessTarget(subject, policyTarget(f.accessPolicy, f.scopeType, f.scopeId));
          if (!ok) {
            logAccessDenied({
              tool: "list_smart_file_folders",
              policy: effectiveAccessPolicy(policyTarget(f.accessPolicy, f.scopeType, f.scopeId)),
              atomJurisdiction: f.scopeType === "jurisdiction" ? f.scopeId : "",
              subjectTenant: subject.jurisdictionTenant,
              platformInternal: subject.platformInternal,
              reason: "folder_list_filter",
            });
          }
          return ok;
        });
        const env = buildEnvelope(
          { scopeType, scopeId, folders, servedAt: data.servedAt },
          [],
          { tier: getCurrentTier(), readKind: "catalog" },
        );
        return envelopeContent(env);
      } catch (err) {
        return errorContent(describeLegacyFailure("list_smart_file_folders", err));
      }
    },
  );

  server.tool(
    "list_smart_file_folder_files",
    TOOL_COPY.list_smart_file_folder_files,
    { folderId: z.string().min(1) },
    async ({ folderId }) => {
      const gate = await requireFilesCaller("list_smart_file_folder_files");
      if (!gate.ok) return gate.content;
      try {
        const data = await smartFilesClient.listFolderFiles(folderId);
        const subject = getCurrentAccessSubject();
        if (
          !canReadAccessTarget(
            subject,
            policyTarget(data.folder.accessPolicy, data.folder.scopeType, data.folder.scopeId),
          )
        ) {
          return errorContent(
            `list_smart_file_folder_files: access denied for folder accessPolicy ${data.folder.accessPolicy}`,
          );
        }
        const files = data.files.filter((f) =>
          canReadAccessTarget(
            subject,
            policyTarget(f.accessPolicy, f.scopeType, f.scopeId),
          ),
        );
        const env = buildEnvelope(
          {
            folder: data.folder,
            files,
            countingRule: data.countingRule,
            fileCount: files.length,
            servedAt: data.servedAt,
          },
          [],
          { tier: getCurrentTier(), readKind: "catalog" },
        );
        return envelopeContent(env);
      } catch (err) {
        return errorContent(describeLegacyFailure("list_smart_file_folder_files", err));
      }
    },
  );

  server.tool(
    "read_smart_file",
    TOOL_COPY.read_smart_file,
    {
      entityId: z.string().min(1),
      version: z.number().int().positive().optional(),
    },
    async ({ entityId, version }) => {
      const gate = await requireFilesCaller("read_smart_file");
      if (!gate.ok) return gate.content;
      try {
        const data = await smartFilesClient.readFile(entityId, version);
        const status = data.status as string | undefined;
        if (status && status !== "held") {
          const env = buildEnvelope({ read: data }, [], {
            tier: getCurrentTier(),
            readKind: "catalog",
            note: "Typed absence — not a silent empty result.",
          });
          return envelopeContent(env);
        }
        const doc = data.document as { accessPolicy: string; scopeType: string; scopeId: string };
        const subject = getCurrentAccessSubject();
        if (
          !canReadAccessTarget(
            subject,
            policyTarget(doc.accessPolicy, doc.scopeType, doc.scopeId),
          )
        ) {
          return errorContent(
            `read_smart_file: access denied for accessPolicy ${doc.accessPolicy}`,
          );
        }
        const env = buildEnvelope({ read: data }, [], {
          tier: getCurrentTier(),
          readKind: "catalog",
        });
        return envelopeContent(env);
      } catch (err) {
        return errorContent(describeLegacyFailure("read_smart_file", err));
      }
    },
  );

  server.tool(
    "list_smart_file_placements",
    TOOL_COPY.list_smart_file_placements,
    { entityId: z.string().min(1) },
    async ({ entityId }) => {
      const gate = await requireFilesCaller("list_smart_file_placements");
      if (!gate.ok) return gate.content;
      try {
        const readFirst = await smartFilesClient.readFile(entityId);
        const status = readFirst.status as string | undefined;
        if (status && status !== "held") {
          return envelopeContent(
            buildEnvelope({ entityId, read: readFirst, placements: [] }, [], {
              tier: getCurrentTier(),
              readKind: "catalog",
              note: "Document not held — typed absence returned with empty placements.",
            }),
          );
        }
        const doc = readFirst.document as { accessPolicy: string; scopeType: string; scopeId: string };
        const subject = getCurrentAccessSubject();
        if (
          !canReadAccessTarget(
            subject,
            policyTarget(doc.accessPolicy, doc.scopeType, doc.scopeId),
          )
        ) {
          return errorContent(
            `list_smart_file_placements: access denied for accessPolicy ${doc.accessPolicy}`,
          );
        }
        const data = await smartFilesClient.listPlacements(entityId);
        const env = buildEnvelope(data, [], {
          tier: getCurrentTier(),
          readKind: "catalog",
        });
        return envelopeContent(env);
      } catch (err) {
        return errorContent(describeLegacyFailure("list_smart_file_placements", err));
      }
    },
  );

  server.tool(
    "create_smart_file_folder",
    TOOL_COPY.create_smart_file_folder,
    {
      orgId: z.string().min(1),
      userId: z.string().min(1),
      label: z.string().min(1),
    },
    async ({ orgId, userId, label }) => {
      const gate = await requireFilesCaller("create_smart_file_folder");
      if (!gate.ok) return gate.content;
      try {
        const data = await smartFilesClient.createFolder({ orgId, userId, label });
        return envelopeContent(
          buildEnvelope(data, [], { tier: getCurrentTier(), readKind: "catalog" }),
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("create_smart_file_folder", err));
      }
    },
  );

  server.tool(
    "upload_smart_file",
    TOOL_COPY.upload_smart_file,
    {
      folderId: z.string().min(1),
      orgId: z.string().min(1),
      userId: z.string().min(1),
      title: z.string().min(1),
      bytesBase64: z.string().min(1),
      contentType: z.string().optional(),
    },
    async (args) => {
      const gate = await requireFilesCaller("upload_smart_file");
      if (!gate.ok) return gate.content;
      try {
        const data = await smartFilesClient.uploadFile(args.folderId, args);
        return envelopeContent(
          buildEnvelope(data, [], { tier: getCurrentTier(), readKind: "catalog" }),
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("upload_smart_file", err));
      }
    },
  );

  server.tool(
    "share_smart_file_folder",
    TOOL_COPY.share_smart_file_folder,
    {
      folderId: z.string().min(1),
      orgId: z.string().min(1),
      userId: z.string().min(1),
    },
    async ({ folderId, orgId, userId }) => {
      const gate = await requireFilesCaller("share_smart_file_folder");
      if (!gate.ok) return gate.content;
      try {
        const data = await smartFilesClient.shareFolder(folderId, { orgId, userId });
        return envelopeContent(
          buildEnvelope(data, [], { tier: getCurrentTier(), readKind: "catalog" }),
        );
      } catch (err) {
        return errorContent(describeLegacyFailure("share_smart_file_folder", err));
      }
    },
  );
}

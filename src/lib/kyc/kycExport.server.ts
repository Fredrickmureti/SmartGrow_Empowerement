/**
 * Client KYC export — server-side package builder.
 *
 * Security model: the caller's bearer token is used to create a user-scoped
 * Supabase client, so the existing `mf_can_scoped` RLS policies on
 * `mf_clients` and on the private `mf-kyc` storage bucket are the
 * authorization boundary. Nothing here uses the service role, and no
 * business/branch id supplied by the browser is ever trusted as permission —
 * it can only narrow a set the database already allows.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { zipSync, type Zippable } from "fflate";
import {
  KYC_CLIENT_COLUMNS,
  KYC_DOCUMENTS,
  buildBulkManifestCsv,
  buildExceptionsText,
  clientFolderEntries,
  clientFolderName,
  summarize,
  type KycClientPackage,
  type KycClientRow,
  type KycDocumentKind,
  type KycDocumentResult,
  type KycExportSummary,
} from "./kycExportPackage";

const KYC_BUCKET = "mf-kyc";
/** Guard rail for a synchronous package build in the edge runtime. */
export const BULK_CLIENT_CAP = 300;

export interface KycExportRequest {
  mode: "single" | "bulk";
  clientId?: string;
  businessId?: string;
  branchId?: string | null;
  status?: string | null;
  clientIds?: string[] | null;
}

export interface KycExportResult {
  filename: string;
  bytes: Uint8Array;
  summary: KycExportSummary;
}

export class KycExportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function userScopedClient(token: string): SupabaseClient {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) {
    throw new KycExportError("Export is not configured on the server", 500);
  }
  return createClient(url, key, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) {
          headers.delete("Authorization");
        }
        headers.set("apikey", key);
        headers.set("Authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
    },
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

const encoder = new TextEncoder();
const encode = (text: string) => encoder.encode(text);

async function loadBranchNames(
  supabase: SupabaseClient,
  branchIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (branchIds.length === 0) return map;
  const { data } = await supabase.from("branches").select("id,name").in("id", branchIds);
  for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
    map.set(row.id, row.name);
  }
  return map;
}

/** Downloads the client's own KYC files, one client at a time, under RLS. */
async function collectClient(
  supabase: SupabaseClient,
  client: KycClientRow,
  branchName: string | null,
): Promise<{ pkg: KycClientPackage; files: Map<KycDocumentKind, Uint8Array> }> {
  const documents: KycDocumentResult[] = [];
  const files = new Map<KycDocumentKind, Uint8Array>();

  for (const doc of KYC_DOCUMENTS) {
    const path = (client as unknown as Record<string, string | null>)[doc.column] ?? null;
    if (!path) {
      documents.push({
        kind: doc.kind,
        label: doc.label,
        exportedPath: null,
        originalFilename: null,
        byteSize: null,
        status: "not_captured",
      });
      continue;
    }

    // A stored path must belong to this client's own folder. A mismatch means
    // the record is inconsistent — never copy such a file into the package.
    const expectedPrefix = `${client.business_id}/${client.id}/`;
    if (!path.startsWith(expectedPrefix)) {
      documents.push({
        kind: doc.kind,
        label: doc.label,
        exportedPath: null,
        originalFilename: path.split("/").pop() ?? null,
        byteSize: null,
        status: "unavailable",
        reason: "stored file does not belong to this client record",
      });
      continue;
    }

    try {
      const { data, error } = await supabase.storage.from(KYC_BUCKET).download(path);
      if (error || !data) throw error ?? new Error("file not found");
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("stored file is empty");
      files.set(doc.kind, bytes);
      documents.push({
        kind: doc.kind,
        label: doc.label,
        exportedPath: doc.zipPath,
        originalFilename: path.split("/").pop() ?? null,
        byteSize: bytes.byteLength,
        status: "exported",
      });
    } catch (e) {
      documents.push({
        kind: doc.kind,
        label: doc.label,
        exportedPath: null,
        originalFilename: path.split("/").pop() ?? null,
        byteSize: null,
        status: "unavailable",
        // Deliberately no storage path or credential detail in the reason.
        reason: e instanceof Error && e.message ? e.message : "could not be retrieved",
      });
    }
  }

  return {
    pkg: { client, folder: clientFolderName(client), branchName, documents },
    files,
  };
}

async function recordAudit(
  supabase: SupabaseClient,
  businessId: string,
  summary: KycExportSummary,
  entityId: string | null,
  entityName: string,
) {
  try {
    const { data: business } = await supabase
      .from("businesses")
      .select("id,organization_id")
      .eq("id", businessId)
      .maybeSingle();
    const organizationId = (business as { organization_id?: string } | null)?.organization_id;
    if (!organizationId) return;
    const { data: userData } = await supabase.auth.getUser();
    await supabase.from("audit_logs").insert({
      organization_id: organizationId,
      business_id: businessId,
      user_id: userData?.user?.id ?? null,
      action: "exported",
      entity_type: summary.mode === "single" ? "mf_client" : "mf_client_kyc_bulk",
      entity_id: entityId,
      entity_name: entityName,
      changes_summary:
        summary.mode === "single"
          ? `KYC package exported for ${entityName} (${summary.documentsExported} file(s), ${summary.documentsUnavailable} unavailable)`
          : `Bulk KYC export of ${summary.clientCount} client(s) — ${summary.documentsExported} file(s), ${summary.documentsUnavailable} unavailable`,
      // Scope and counts only — never document contents.
      new_values: {
        export_id: summary.exportId,
        mode: summary.mode,
        client_count: summary.clientCount,
        documents_exported: summary.documentsExported,
        documents_unavailable: summary.documentsUnavailable,
        documents_not_captured: summary.documentsNotCaptured,
        status: summary.status,
        scope: summary.scope,
      } as never,
    } as never);
  } catch (e) {
    // A failed audit write must not silently succeed the export.
    throw new KycExportError(
      `Export was not completed because it could not be recorded in the audit trail: ${
        e instanceof Error ? e.message : "unknown error"
      }`,
      500,
    );
  }
}

export async function buildKycExport(
  token: string,
  request: KycExportRequest,
): Promise<KycExportResult> {
  const supabase = userScopedClient(token);
  const exportedAt = new Date().toISOString();
  const exportId = `KYCX-${exportedAt.replace(/[-:T.]/g, "").slice(0, 14)}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}`;

  const select = KYC_CLIENT_COLUMNS.join(",");
  let clients: KycClientRow[] = [];
  const scope: Record<string, unknown> = { mode: request.mode };

  if (request.mode === "single") {
    if (!request.clientId) throw new KycExportError("A client is required");
    // RLS decides visibility: an id outside the caller's business/branch/own
    // portfolio scope simply returns no row.
    const { data, error } = await supabase
      .from("mf_clients")
      .select(select)
      .eq("id", request.clientId)
      .maybeSingle();
    if (error) throw new KycExportError(error.message, 403);
    if (!data) throw new KycExportError("You are not allowed to export this client", 403);
    clients = [data as unknown as KycClientRow];
  } else {
    if (!request.businessId) throw new KycExportError("An institution is required");
    // The supplied business is verified against the caller's own access before
    // it is used, and RLS re-checks every client row regardless.
    const { data: business, error: bizError } = await supabase
      .from("businesses")
      .select("id")
      .eq("id", request.businessId)
      .maybeSingle();
    if (bizError) throw new KycExportError(bizError.message, 403);
    if (!business) throw new KycExportError("You are not allowed to export this institution", 403);

    let q = supabase
      .from("mf_clients")
      .select(select)
      .eq("business_id", request.businessId)
      .order("client_number", { ascending: true });
    if (request.branchId) q = q.eq("branch_id", request.branchId);
    if (request.status && request.status !== "all") q = q.eq("status", request.status);
    if (request.clientIds && request.clientIds.length > 0) q = q.in("id", request.clientIds);
    const { data, error } = await q.limit(BULK_CLIENT_CAP + 1);
    if (error) throw new KycExportError(error.message, 403);
    clients = (data ?? []) as unknown as KycClientRow[];
    if (clients.length > BULK_CLIENT_CAP) {
      throw new KycExportError(
        `This export covers more than ${BULK_CLIENT_CAP} clients. Narrow the branch or status and try again.`,
      );
    }
    if (clients.length === 0) {
      throw new KycExportError("There are no clients to export in this scope");
    }
    scope["business_id"] = request.businessId;
    scope["branch_id"] = request.branchId ?? null;
    scope["client_status"] = request.status ?? "all";
    scope["selection"] = request.clientIds?.length ? "selected" : "all_in_scope";
  }

  const branchNames = await loadBranchNames(
    supabase,
    [...new Set(clients.map((c) => c.branch_id))],
  );

  const packages: KycClientPackage[] = [];
  const entries: Zippable = {};
  for (const client of clients) {
    const { pkg, files } = await collectClient(
      supabase,
      client,
      branchNames.get(client.branch_id) ?? null,
    );
    packages.push(pkg);
    const folderEntries = clientFolderEntries(pkg, files, exportedAt, encode);
    for (const [path, bytes] of Object.entries(folderEntries)) {
      // Already-compressed images are stored, not recompressed. Byte content
      // is identical either way.
      entries[path] = [bytes, { level: /\.(jpe?g|png|pdf)$/i.test(path) ? 0 : 6 }];
    }
  }

  const summary = summarize(packages, {
    exportId,
    exportedAt,
    mode: request.mode,
    scope,
  });

  if (request.mode === "bulk") {
    entries["manifest.csv"] = [encode(buildBulkManifestCsv(packages)), { level: 6 }];
  }
  entries["manifest.json"] = [
    encode(
      `${JSON.stringify(
        {
          export_id: summary.exportId,
          exported_at: summary.exportedAt,
          mode: summary.mode,
          scope: summary.scope,
          status: summary.status,
          clients: packages.map((p) => ({
            reference: p.client.client_number,
            name: p.client.full_name,
            branch: p.branchName,
            status: p.client.status,
            folder: p.folder,
            documents: p.documents.map((d) => ({
              kind: d.kind,
              exported_path: d.exportedPath ? `${p.folder}/${d.exportedPath}` : null,
              original_filename: d.originalFilename,
              byte_size: d.byteSize,
              result: d.status,
              ...(d.reason ? { reason: d.reason } : {}),
            })),
          })),
          totals: {
            clients: summary.clientCount,
            documents_exported: summary.documentsExported,
            documents_unavailable: summary.documentsUnavailable,
            documents_not_captured: summary.documentsNotCaptured,
          },
        },
        null,
        2,
      )}\n`,
    ),
    { level: 6 },
  ];
  const exceptions = buildExceptionsText(packages);
  if (exceptions) entries["exceptions.txt"] = [encode(exceptions), { level: 6 }];

  const single = packages[0];
  const filename =
    request.mode === "single" && single
      ? `${single.folder}_KYC.zip`
      : `kyc-export-${exportedAt.slice(0, 10)}.zip`;

  const businessId = clients[0]!.business_id;
  await recordAudit(
    supabase,
    businessId,
    summary,
    request.mode === "single" ? clients[0]!.id : null,
    request.mode === "single"
      ? `${clients[0]!.client_number} — ${clients[0]!.full_name}`
      : `${summary.clientCount} client(s)`,
  );

  return { filename, bytes: zipSync(entries), summary };
}

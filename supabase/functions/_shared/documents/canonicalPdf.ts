/**
 * canonicalPdf — resolve the ONE canonical PDF for a business document.
 *
 * Enterprise invariant (ADR-0084, and the convergence plan of 2026-08-06):
 *
 *   One canonical artifact per (document, medium, template version).
 *   Disposition — print, preview, email, export, archive — SELECTS an
 *   artifact. It never selects a renderer.
 *
 * Before this module existed, printing rendered the frozen
 * `document_records.snapshot` through `render-document`, while email
 * re-fetched live rows through `generate-document`. The layout agreed
 * (both bottom out in `_shared/pdfGenerator.ts`) but the *content* could
 * not: an invoice emailed after an edit did not match the invoice that had
 * been printed and archived.
 *
 * Resolution order, most-canonical first:
 *
 *   1. An already-persisted `document_artifacts` PDF for this document —
 *      literally the archived bytes. Byte-identical to what was printed.
 *   2. A `document_records` row → `render-document`, which renders the
 *      frozen snapshot and persists the artifact for next time.
 *   3. `null` — the caller falls back to its legacy path. Document kinds
 *      with no snapshot builder yet (payroll/statutory generators) take
 *      this branch on purpose.
 *
 * This module never renders bytes itself and never talks to hardware.
 */

// Loose client type: callers construct their own client (pinned at @2 in the
// email function, @2.45.0 in the engine); a structural mismatch between
// those generic parameters must not block the shared helper.
// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export type CanonicalPdfSource =
  | "artifact"
  | "render-document"
  | "legacy-fallback";

export interface CanonicalPdfResult {
  bytes: Uint8Array;
  /** Where the bytes came from — logged so drift is observable in prod. */
  source: CanonicalPdfSource;
  /** `document_records.id`, when one backs the document. */
  documentRecordId: string | null;
  /** `document_artifacts.id`, when the bytes were the archived ones. */
  artifactId: string | null;
}

interface ResolveInput {
  supabase: SupabaseClient;
  /** Legacy `(documentType, documentId)` pair the caller already speaks. */
  documentType: string;
  documentId: string;
  /** Paper the disposition wants. Email always wants a page format. */
  paperFormat?: string | null;
  /** Caller JWT, forwarded to `render-document` for org-member checks. */
  authorization: string;
  /** Exact frozen record identity. Required by revision-addressed flows. */
  documentRecordId?: string | null;
}

/**
 * The newest persisted PDF artifact for a document, if one exists.
 *
 * `document_artifacts` is append-only and content-addressed, so the highest
 * version row is the current representation of the document. A superseded
 * row is never returned: it describes a document state that no longer holds.
 */
async function latestPdfArtifact(
  supabase: SupabaseClient,
  documentId: string,
): Promise<{ id: string; bucket: string; path: string } | null> {
  const { data, error } = await supabase
    .from("document_artifacts")
    .select("id, storage_bucket, storage_path, mime_type, superseded_by")
    .eq("document_id", documentId)
    .eq("render_mode", "pdf")
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  if (data.mime_type && data.mime_type !== "application/pdf") return null;
  return {
    id: data.id as string,
    bucket: (data.storage_bucket as string) ?? "document-artifacts",
    path: data.storage_path as string,
  };
}

/** The document-model record backing a legacy `(type, id)` pair. */
async function findDocumentRecord(
  supabase: SupabaseClient,
  documentType: string,
  documentId: string,
): Promise<string | null> {
  // The source pair is the stable identity; `kind_code` is derived from it.
  // Match on the id first (indexed, and unique in practice) and only use the
  // doc type to disambiguate the rare case of a shared id across modules.
  const { data, error } = await supabase
    .from("document_records")
    .select("id, source_doc_type")
    .eq("source_doc_id", documentId)
    .is("superseded_by", null)
    .order("created_at", { ascending: false });

  if (error || !data?.length) return null;
  const exact = data.find(
    (row: { source_doc_type?: string | null }) =>
      row.source_doc_type === documentType,
  );
  return ((exact ?? data[0]).id as string) ?? null;
}

/**
 * Resolve the canonical PDF, or `null` when this document kind has not been
 * onboarded onto the document model yet.
 */
export async function resolveCanonicalPdf(
  input: ResolveInput,
): Promise<CanonicalPdfResult | null> {
  const { supabase, documentType, documentId, paperFormat, authorization } = input;

  const recordId = input.documentRecordId ??
    await findDocumentRecord(supabase, documentType, documentId);
  if (!recordId) return null;

  // 1. Archived bytes win. Re-rendering a document we already rendered is
  //    both wasteful and a chance to disagree with the printed copy.
  const artifact = await latestPdfArtifact(supabase, recordId);
  if (artifact) {
    const { data, error } = await supabase.storage
      .from(artifact.bucket)
      .download(artifact.path);
    if (!error && data) {
      return {
        bytes: new Uint8Array(await data.arrayBuffer()),
        source: "artifact",
        documentRecordId: recordId,
        artifactId: artifact.id,
      };
    }
    console.error(
      `[canonicalPdf] artifact ${artifact.id} unreadable, re-rendering:`,
      error?.message,
    );
  }

  // 2. No artifact yet — render the frozen snapshot through the ONE render
  //    endpoint, which persists an artifact as a side effect.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const response = await fetch(`${supabaseUrl}/functions/v1/render-document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify({
      medium: "pdf",
      document_id: recordId,
      persist: true,
      options: paperFormat ? { paper_format: paperFormat } : {},
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`render-document failed for ${documentType}: ${detail}`);
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    source: "render-document",
    documentRecordId: recordId,
    artifactId: null,
  };
}

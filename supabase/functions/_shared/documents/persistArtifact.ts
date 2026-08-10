/**
 * ADR-0084 Wave B3.2 — post-render artifact persistence.
 *
 * Called from `generate-document` after each successful non-preview
 * render. Idempotent under retry via content-sha256 dedupe: if the
 * latest artifact for (business, type, doc) already matches the bytes,
 * we reuse it and skip both upload and insert.
 *
 * Rules:
 *   - Never fails the render. All errors are logged and swallowed.
 *   - Non-blocking by default for non-fiscal document types; blocking
 *     for invoice/receipt where auditors need the guarantee (see
 *     ADR-0084 §Consequences). Caller controls via `blocking` flag.
 *   - service_role client only. `document_artifacts` has no
 *     authenticated INSERT policy.
 */

const PERSIST_ALLOWLIST = new Set<string>([
  "invoice",
  "bill",
  "credit_note",
  "vendor_credit_note",
  "receipt",
  "pos_receipt",
  "delivery_note",
  "purchase_order",
  "sales_order",
  "estimate",
  "proforma",
  "proforma_invoice",
  "statement",
  "customer_statement",
  "vendor_statement",
  "legal_recipient_statement",
  "payslip",
  "payment",
  "sales_return",
  "purchase_return",
  "rfq",
  "requisition",
  // Phase 6.1 — HR letter renderers. Each letter is an immutable
  // artifact for HR audit + employee record trails (ADR-0084).
  "offer_letter",
  "promotion_letter",
  "warning_letter",
  "contract_letter",
]);

const BLOCKING_TYPES = new Set<string>([
  "invoice",
  "pos_receipt",
  "receipt",
  "payslip",
  // HR: an issued letter must survive the request lifecycle so that the
  // employee copy delivered downstream matches the archived version.
  "offer_letter",
  "contract_letter",
]);

const EXT_FOR_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/octet-stream": "bin",
  // Milestone C.1 — tabular exports (CSV first; xlsx queued behind a
  // bundle-size review, see plan risks). `render_mode: "export"` is the
  // discriminator; the mime type drives the storage extension only.
  "text/csv": "csv",
  "text/csv; charset=utf-8": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export interface PersistArtifactInput {
  supabase: any;
  bytes: Uint8Array;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  documentType: string;
  documentId: string;
  documentNumber: string | null;
  intent: string | null;
  templateId: string | null;
  templateVersion: number | null;
  policyId: string | null;
  mimeType: string;
  renderMode: "pdf" | "escpos" | "zpl" | string;
  paperFormat: string;
  copies: number;
  renderedBy: string | null;
  renderedVia: string; // "generate-document"
  metadata?: Record<string, unknown>;
}

export interface PersistedArtifact {
  id: string;
  version: number;
  deduped: boolean;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shouldPersistArtifact(
  documentType: string,
  opts: { persistOptIn?: boolean } = {},
): boolean {
  if (opts.persistOptIn === false) return false;
  return PERSIST_ALLOWLIST.has(documentType) || PERSIST_ALLOWLIST.has(baseDocumentType(documentType));
}

export function isBlockingType(documentType: string): boolean {
  return BLOCKING_TYPES.has(documentType) || BLOCKING_TYPES.has(baseDocumentType(documentType));
}

function baseDocumentType(documentType: string): string {
  const parts = documentType.split(".");
  return parts[parts.length - 1] ?? documentType;
}

export async function persistArtifact(
  input: PersistArtifactInput,
): Promise<PersistedArtifact | null> {
  const {
    supabase,
    bytes,
    organizationId,
    businessId,
    documentType,
    documentId,
  } = input;
  if (!organizationId || !businessId || !documentId) return null;
  try {
    const sha = await sha256Hex(bytes);

    // Dedupe against the current row for this exact frozen document.
    const { data: latest } = await supabase
      .from("document_artifacts")
      .select("id, version, content_sha256")
      .eq("business_id", businessId)
      .eq("document_type", documentType)
      .eq("document_id", documentId)
      .is("superseded_by", null)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest && latest.content_sha256 === sha) {
      return { id: latest.id, version: latest.version, deduped: true };
    }

    const ext = EXT_FOR_MIME[input.mimeType] ?? "bin";
    const artifactId = crypto.randomUUID();
    const storagePath =
      `${businessId}/${documentType}/${documentId}/${artifactId}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from("document-artifacts")
      .upload(storagePath, bytes, {
        contentType: input.mimeType,
        cacheControl: "31536000",
        upsert: false,
      });
    if (uploadErr) {
      console.error("[persistArtifact] upload failed:", uploadErr.message);
      return null;
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("document_artifacts")
      .insert({
        id: artifactId,
        organization_id: organizationId,
        business_id: businessId,
        branch_id: input.branchId,
        document_type: documentType,
        document_id: documentId,
        document_number: input.documentNumber,
        intent: input.intent,
        template_id: input.templateId,
        template_version: input.templateVersion,
        policy_id: input.policyId,
        storage_bucket: "document-artifacts",
        storage_path: storagePath,
        mime_type: input.mimeType,
        byte_size: bytes.byteLength,
        content_sha256: sha,
        render_mode: input.renderMode,
        paper_format: input.paperFormat,
        copies: input.copies,
        rendered_by: input.renderedBy,
        rendered_via: input.renderedVia,
        supersedes_id: latest?.id ?? null,
        metadata: input.metadata ?? {},
      })
      .select("id, version")
      .single();

    if (insertErr) {
      console.error("[persistArtifact] insert failed:", insertErr.message);
      // Best-effort cleanup so we don't leave orphaned objects.
      await supabase.storage
        .from("document-artifacts")
        .remove([storagePath])
        .catch(() => {});
      return null;
    }

    if (latest?.id) {
      const { error: supersedeErr } = await supabase
        .from("document_artifacts")
        .update({ superseded_by: inserted.id })
        .eq("id", latest.id)
        .is("superseded_by", null);
      if (supersedeErr) {
        console.error("[persistArtifact] supersession link failed:", supersedeErr.message);
      }
    }

    return { id: inserted.id, version: inserted.version, deduped: false };
  } catch (err) {
    console.error("[persistArtifact] unexpected:", (err as Error).message);
    return null;
  }
}

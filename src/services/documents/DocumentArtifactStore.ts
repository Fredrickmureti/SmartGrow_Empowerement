/**
 * DocumentArtifactStore — client wrapper over the `document_artifacts`
 * table + `document-artifacts` storage bucket (ADR-0084).
 *
 * The client is READ-ONLY. Only edge functions (service_role) may insert
 * artifacts; the RLS policy on `document_artifacts` grants no INSERT/UPDATE/
 * DELETE to authenticated users on purpose (append-only, immutable).
 *
 * Callers should use this store on the reprint / regen-history path:
 *   - `latest()`  — the newest rendered version of a document
 *   - `list()`    — full version history for the history panel
 *   - `signedUrl()` — short-lived download URL for previewing an artifact
 *
 * NEW renders MUST still go through `printClient.print()` (which invokes
 * the `generate-document` edge function server-side). This store never
 * *creates* a render; it exposes what has already been stored.
 */

import { supabase } from "@/integrations/supabase/client";

// The generated Supabase types file is regenerated from the live schema,
// so a hand-typed row shape keeps this module usable during the window
// between the migration landing and the types being refreshed.
export interface DocumentArtifact {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  document_type: string;
  document_id: string;
  document_number: string | null;
  intent: string | null;
  version: number;
  template_id: string | null;
  template_version: number | null;
  policy_id: string | null;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  content_sha256: string;
  page_count: number | null;
  render_mode: "pdf" | "zpl" | "escpos" | "html" | "png";
  paper_format: string;
  copies: number;
  rendered_by: string | null;
  rendered_via: string;
  regeneration_reason: string | null;
  supersedes_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DocumentArtifactKey {
  businessId: string;
  documentType: string;
  documentId: string;
}

const TABLE = "document_artifacts";

/**
 * Signed URLs are the ONLY supported way to fetch bytes — the bucket is
 * private and the storage-objects RLS policy is prefix-based on business_id.
 */
const SIGNED_URL_TTL_SECONDS = 5 * 60;

export const documentArtifactStore = {
  /**
   * Newest artifact for a (documentType, documentId). Returns `null` when
   * nothing has been rendered yet — callers should then trigger a fresh
   * render via `printClient.print()`.
   */
  async latest(key: DocumentArtifactKey): Promise<DocumentArtifact | null> {
    // Prefer the RPC (uses the DB-side ORDER BY + LIMIT) so pagination
    // rules and future soft-delete logic live in one place.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("document_artifacts_latest", {
      p_business_id: key.businessId,
      p_document_type: key.documentType,
      p_document_id: key.documentId,
    });

    if (error) {
      // The RPC may not exist yet in a stale local shadow — fall through
      // to a plain table query rather than surfacing a hard failure.
      const fallback = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from(TABLE as any)
        .select("*")
        .eq("business_id", key.businessId)
        .eq("document_type", key.documentType)
        .eq("document_id", key.documentId)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (fallback.error) throw fallback.error;
      return (fallback.data as unknown as DocumentArtifact | null) ?? null;
    }

    const rows = (data ?? []) as unknown as DocumentArtifact[];
    return rows[0] ?? null;
  },

  /**
   * Full version history for the reprint / audit UI. Newest first.
   */
  async list(key: DocumentArtifactKey): Promise<DocumentArtifact[]> {
    const { data, error } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(TABLE as any)
      .select("*")
      .eq("business_id", key.businessId)
      .eq("document_type", key.documentType)
      .eq("document_id", key.documentId)
      .order("version", { ascending: false });

    if (error) throw error;
    return (data ?? []) as unknown as DocumentArtifact[];
  },

  /**
   * Short-lived signed URL to view/download a stored artifact. Callers
   * MUST NOT cache the URL — regenerate on demand.
   */
  async signedUrl(artifact: DocumentArtifact): Promise<string> {
    const { data, error } = await supabase.storage
      .from(artifact.storage_bucket)
      .createSignedUrl(artifact.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error) throw error;
    if (!data?.signedUrl) throw new Error("No signed URL returned");
    return data.signedUrl;
  },
};

export type DocumentArtifactStore = typeof documentArtifactStore;

/**
 * printing/render — the ONE rendering seam.
 *
 * Turns a document identity into bytes. Nothing else in the app may
 * invoke a render endpoint: pages, hooks and sagas describe *what* to
 * print, this module decides *how* the bytes are produced.
 *
 * One backend, one contract: `renderDocumentRecord`. Every printable
 * artifact has a `document_records` row (ADR-0084); rendering goes to
 * `render-document`, persists a `document_artifacts` row, and returns the
 * same bytes that were archived, so a reprint years later is
 * byte-identical because the artifact IS the record.
 *
 * The legacy `renderSourceDocument` / `generate-document` backend is gone.
 * Surfaces that still speak a bare `(documentType, documentId)` pair are
 * bridged by `@/services/documents/resolveSourceDocumentRecord`, which
 * freezes the pair into a record before it reaches this module.
 */
import { supabase } from '@/integrations/supabase/client';
import { withSpan } from '@/services/observability/trace';

export type RenderMedium = 'pdf' | 'escpos' | 'zpl' | 'html';

/**
 * Optional paper-format override accepted at every render entry point.
 * Lives with the render seam so the printing service is the single source
 * of truth for the shape of a render request.
 */
export type PaperFormatOption =
  | 'a4' | 'letter' | 'a5' | '80mm' | '58mm' | '40mm'
  | { widthMm: number; heightMm: number | 'auto' };

/**
 * What the server actually resolved for this render. Reported back on
 * every call so preview and diagnostics surfaces can show the operator
 * *why* a document came out thermal or A4 without re-deriving policy.
 */
export interface DocumentRenderPolicyInfo {
  source: string;
  paper: string;
  renderMode: string;
  /** Thermal character columns; null for PDF renders. */
  columns: number | null;
  font: string | null;
  /** `media_profiles.id` the policy resolved to, when one applied. */
  profileId: string | null;
  /** True when the server overrode the requested paper/render mode. */
  coerced: boolean;
}

export interface RenderedArtifact {
  medium: RenderMedium;
  mimeType: string;
  /** Present for every medium. PDF callers use `blob`. */
  bytes: Uint8Array;
  /** Only materialised for `pdf` so print/download paths avoid a copy. */
  blob?: Blob;
  /** `document_artifacts.id` when the render was persisted. */
  artifactId: string | null;
  /**
   * What the server decided about paper and render mode. Preview surfaces
   * show this to the operator; print paths ignore it.
   */
  policy?: DocumentRenderPolicyInfo | null;
  /** Renderer-reported facts (resolved paper, columns, font, template). */
  metadata?: Record<string, unknown>;
}


interface RenderEnvelope {
  medium?: RenderMedium;
  mime_type?: string;
  bytes_base64?: string;
  artifact_id?: string | null;
  metadata?: Record<string, unknown>;
}

function decodeEnvelope(data: unknown, requested: RenderMedium): RenderedArtifact {
  const envelope = (typeof data === 'string' ? JSON.parse(data) : data) as RenderEnvelope | null;
  if (!envelope?.bytes_base64) throw new Error('render_returned_no_bytes');
  const binary = atob(envelope.bytes_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const medium = envelope.medium ?? requested;
  const mimeType = envelope.mime_type ?? mimeFor(medium);
  const metadata = envelope.metadata ?? {};
  return {
    medium,
    mimeType,
    bytes,
    blob: medium === 'pdf' ? bytesToBlob(bytes, mimeType) : undefined,
    artifactId: envelope.artifact_id ?? null,
    metadata,
    policy: policyFromMetadata(metadata, medium),
  };
}

/**
 * Translate renderer-reported facts into the policy shape the UI shows.
 * Only the thermal renderer reports resolved geometry today; other media
 * report nothing and the policy stays null.
 */
function policyFromMetadata(
  metadata: Record<string, unknown>,
  medium: RenderMedium,
): DocumentRenderPolicyInfo | null {
  const paper = metadata['resolved_paper'];
  if (typeof paper !== 'string') return null;
  const columns = metadata['resolved_columns'];
  const font = metadata['resolved_font'];
  return {
    source: (metadata['scope'] as string) ?? 'template',
    paper,
    renderMode: medium,
    columns: typeof columns === 'number' ? columns : null,
    font: typeof font === 'string' ? font : null,
    profileId: (metadata['media_profile_id'] as string | undefined) ?? null,
    coerced: metadata['coerced'] === true,
  };
}

function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: mimeType });
}

/** Render (and archive) a document-model record. */
export async function renderDocumentRecord(input: {
  documentRecordId: string;
  medium: RenderMedium;
  options?: Record<string, unknown>;
  /**
   * Trace key of the print that asked for this render. Passed explicitly so
   * concurrent prints (multi-copy receipts, label + invoice at once) each
   * keep their own waterfall instead of racing on an ambient trace.
   */
  correlationId?: string;
}): Promise<RenderedArtifact> {
  // Split the edge round trip from the decode so the waterfall separates
  // "the renderer is slow" from "the payload is huge".
  const { data, error } = await withSpan(
    'render.edge_invoke',
    () =>
      supabase.functions.invoke('render-document', {
        body: {
          medium: input.medium,
          document_id: input.documentRecordId,
          options: input.options ?? {},
          persist: true,
        },
        headers: { Accept: 'application/json' },
      }),
    { medium: input.medium, persist: true },
    input.correlationId,
  );
  if (error) throw new Error(`render_failed: ${error.message}`);
  return withSpan(
    'render.decode',
    () => decodeEnvelope(data, input.medium),
    undefined,
    input.correlationId,
  );
}



/**
 * Render an *unsaved* snapshot — the preview seam.
 *
 * Used where there is no persisted document to freeze yet: the receipt
 * test print renders the settings the operator is editing right now.
 * Nothing is archived (`persist: false`), so a preview can never be
 * mistaken for a reprintable business artifact.
 */
export async function renderPreviewSnapshot(input: {
  kindCode: string;
  organizationId: string;
  businessId: string;
  branchId?: string | null;
  snapshot: Record<string, unknown>;
  medium: RenderMedium;
  options?: Record<string, unknown>;
}): Promise<RenderedArtifact> {
  const { data, error } = await supabase.functions.invoke('render-document', {
    body: {
      medium: input.medium,
      preview: {
        kind_code: input.kindCode,
        organization_id: input.organizationId,
        business_id: input.businessId,
        branch_id: input.branchId ?? null,
        snapshot: input.snapshot,
      },
      options: input.options ?? {},
      persist: false,
    },
    headers: { Accept: 'application/json' },
  });
  if (error) throw new Error(`render_failed: ${error.message}`);
  return decodeEnvelope(data, input.medium);
}


function mimeFor(medium: RenderMedium): string {
  switch (medium) {
    case 'pdf': return 'application/pdf';
    case 'html': return 'text/html';
    default: return 'application/octet-stream';
  }
}

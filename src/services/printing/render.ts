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
import type { PaperFormatOption, DocumentRenderPolicyInfo } from '@/services/printing/pdfUtils';

export type RenderMedium = 'pdf' | 'escpos' | 'zpl' | 'html';
export type { DocumentRenderPolicyInfo, PaperFormatOption };

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
}


function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: mimeType });
}

/** Render (and archive) a document-model record. */
export async function renderDocumentRecord(input: {
  documentRecordId: string;
  medium: RenderMedium;
  options?: Record<string, unknown>;
}): Promise<RenderedArtifact> {
  const { data, error } = await supabase.functions.invoke('render-document', {
    body: {
      medium: input.medium,
      document_id: input.documentRecordId,
      options: input.options ?? {},
      persist: true,
    },
    headers: { Accept: 'application/json' },
  });
  if (error) throw new Error(`render_failed: ${error.message}`);

  const envelope = (typeof data === 'string' ? JSON.parse(data) : data) as {
    medium?: RenderMedium;
    mime_type?: string;
    bytes_base64?: string;
    artifact_id?: string | null;
  } | null;
  if (!envelope?.bytes_base64) {
    throw new Error('render_returned_no_bytes');
  }
  const binary = atob(envelope.bytes_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const medium = envelope.medium ?? input.medium;
  const mimeType = envelope.mime_type ?? mimeFor(medium);
  return {
    medium,
    mimeType,
    bytes,
    blob: medium === 'pdf' ? bytesToBlob(bytes, mimeType) : undefined,
    artifactId: envelope.artifact_id ?? null,
  };
}


function mimeFor(medium: RenderMedium): string {
  switch (medium) {
    case 'pdf': return 'application/pdf';
    case 'html': return 'text/html';
    default: return 'application/octet-stream';
  }
}

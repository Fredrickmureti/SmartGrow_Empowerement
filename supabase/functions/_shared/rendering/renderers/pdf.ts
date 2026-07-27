/**
 * AST → PDF adapter (Wave 3).
 *
 * Bridges the medium-neutral AST to the existing `pdfGenerator`. During
 * the transition the PDF producer still consumes the legacy
 * `DocumentData` snapshot; the AST controls *which* section renderers
 * fire and in what order. Wave 7 replaces the interior with an
 * AST-first layout engine.
 */

import type { AstBlock, RenderContext, ResolvedTemplate } from "../types.ts";
import { generateDocumentPdf } from "../../pdfGenerator.ts";

export async function renderAstToPdf(args: {
  template: ResolvedTemplate;
  context: RenderContext;
  blocks: AstBlock[];
}): Promise<Uint8Array> {
  const snap = args.context.document.snapshot as Record<string, unknown>;
  const documentData = {
    organization: args.context.business as Record<string, unknown> | null,
    document: { ...snap, id: args.context.document.id },
    items: (snap["items"] as unknown[]) ?? [],
    contact: snap["contact"] ?? null,
    payment_terms: snap["payment_terms"] ?? null,
    metadata: {
      template_id: args.template.id,
      template_version: args.template.version,
      block_types: args.blocks.map((b) => b.type),
    },
  } as unknown as Parameters<typeof generateDocumentPdf>[0];
  const bytes = await generateDocumentPdf(
    documentData,
    (args.context.document.kind_code as unknown) as Parameters<typeof generateDocumentPdf>[1],
    (args.context.options as Parameters<typeof generateDocumentPdf>[2]) ?? undefined,
  );
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
}

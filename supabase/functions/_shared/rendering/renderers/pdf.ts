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
import { renderPayslipSnapshotToPdf } from "../../payslip/payslipSnapshot.ts";

/**
 * Kinds whose layout is a statement of computed amounts rather than a
 * line-item commercial document. They carry a fully-resolved report
 * payload in their snapshot and are drawn by a dedicated layout that is a
 * pure function of that snapshot.
 */
const STATEMENT_LAYOUTS: Record<
  string,
  (snapshot: Record<string, unknown>) => Promise<Uint8Array>
> = {
  "payroll.payslip": renderPayslipSnapshotToPdf,
};

export async function renderAstToPdf(args: {
  template: ResolvedTemplate;
  context: RenderContext;
  blocks: AstBlock[];
}): Promise<Uint8Array> {
  // The snapshot IS the DocumentData shape (produced by the per-kind
  // builders in src/services/documents/snapshots/*). Flat, not wrapped
  // under `document`. Previously this adapter wrapped it (leaving
  // top-level `document_number` etc. undefined) and passed
  // `context.document.kind_code` in the `template` argument slot — two
  // shape bugs that made every render-document call for A4 kinds
  // (invoice, estimate, PO, GRN, bill, delivery note, credit note…)
  // crash inside pdf-lib with `text must be of type string, but was
  // actually of type undefined`. Consume the snapshot flat and attach
  // `organization` from context when the snapshot doesn't carry it.
  const snap = args.context.document.snapshot as Record<string, unknown>;

  const statementLayout = STATEMENT_LAYOUTS[args.template.kind_code];
  if (statementLayout) return await statementLayout(snap);


  const documentData = {
    ...snap,
    id: args.context.document.id,
    organization:
      (snap["organization"] as unknown) ??
      (args.context.business as unknown) ??
      null,
    metadata: {
      ...((snap["metadata"] as Record<string, unknown> | undefined) ?? {}),
      template_id: args.template.id,
      template_version: args.template.version,
      block_types: args.blocks.map((b) => b.type),
    },
  } as unknown as Parameters<typeof generateDocumentPdf>[0];
  const bytes = await generateDocumentPdf(
    documentData,
    {},
    (args.context.options as Parameters<typeof generateDocumentPdf>[2]) ?? undefined,
  );
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
}

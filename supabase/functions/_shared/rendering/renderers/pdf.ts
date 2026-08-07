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

  // Thermal gate (ADR-0085 / rendering ownership): a thermal document is
  // structured by the canonical Line[] engine and drawn by the flow-based
  // thermal PDF writer — never by the A4 coordinate renderer, which
  // maintains a second, divergent line-item layout. `generateDocumentPdf`
  // hard-refuses thermal input, so this gate is also what keeps the
  // snapshot path from throwing for POS receipts.
  //
  // Geometry is a property of the MEDIUM, never of the document kind. An
  // explicit `paper_format` from the caller (preview paper picker, print
  // policy override) always wins; only in its absence do the template's
  // `media_class` and the stored POS receipt settings supply the default.
  // This is what lets an operator read a payment receipt on A4 while the
  // branch still prints it at 80 mm.
  const opts = (args.context.options ?? {}) as Record<string, unknown>;
  const rs = (snap["pos_receipt_settings"] ?? null) as
    | Record<string, unknown>
    | null;
  const THERMAL = new Set(["40mm", "58mm", "80mm"]);
  const explicitPaper = String(
    opts["paper_format"] ?? opts["paperFormat"] ?? "",
  ).toLowerCase();
  const defaultPaper =
    args.template.media_class === "thermal"
      ? String(rs?.["paper_size"] ?? "80mm").toLowerCase()
      : String(rs?.["paper_size"] ?? "").toLowerCase();
  const paperToken = explicitPaper || defaultPaper;
  if (THERMAL.has(paperToken)) {
    const [{ documentToReceiptLines }, { renderThermalPdf }] = await Promise.all([
      import("../../receipt/documentToLines.ts"),
      import("../../receipt/pdf/renderThermalPdf.ts"),
    ]);
    const doc = {
      ...snap,
      organization:
        (snap["organization"] as unknown) ??
        (args.context.business as unknown) ??
        null,
    } as unknown as Parameters<typeof documentToReceiptLines>[0];
    const lines = documentToReceiptLines(doc, {
      width: THERMAL.has(paperToken)
        ? (paperToken as "40mm" | "58mm" | "80mm")
        : undefined,
      receiptSettings: rs,
    });
    return await renderThermalPdf(lines);
  }



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

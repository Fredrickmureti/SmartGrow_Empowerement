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
import { generateDocumentPdf, generateStatementPdf } from "../../pdfGenerator.ts";
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

/**
 * Account statements (AR / AP / legal recipient) are a period ledger —
 * opening balance, dated charges/credits, running balance, aging — NOT a
 * line-item commercial document. Routing them through
 * `generateDocumentPdf` produced an invoice-shaped page ("Bill To",
 * Qty/Price/Tax columns, "Balance Due") with an empty item table, because
 * a statement snapshot carries no `items`. They are drawn by
 * `generateStatementPdf`, which is A4-only by construction.
 */
const STATEMENT_KIND_CODES = new Set([
  "sales.statement",
  "purchases.statement",
]);

/**
 * Procurement solicitation / demand documents.
 *
 * Same class of defect as statements, opposite direction: an RFQ and a
 * requisition carry `items` but NO money, so `generateDocumentPdf` would
 * happily render them as an invoice with a zeroed Unit price / Tax /
 * Line total ladder and a "Balance Due" of 0.00. An RFQ that shows a
 * price column is commercially wrong — the supplier is the one being
 * asked to state the price — and a requisition has no counterparty to
 * bill at all.
 *
 * These kinds are drawn by dedicated sheet-only layouts that are a pure
 * function of the frozen snapshot. They sit BEFORE the thermal gate: a
 * misconfigured `document_print_policies` row must not be able to route a
 * specification table onto an 80 mm roll.
 */
const PROCUREMENT_LAYOUTS: Record<
  string,
  (
    snapshot: Record<string, unknown>,
    organization: unknown,
    options: { paperFormat?: string; orientation?: "portrait" | "landscape" },
  ) => Promise<Uint8Array>
> = {
  "purchases.rfq": async (snap, org, opts) =>
    await (await import("../../pdf/layouts/procurement.ts")).generateSolicitationPdf(
      snap,
      org as never,
      opts as never,
    ),
  "purchases.requisition": async (snap, org, opts) =>
    await (await import("../../pdf/layouts/procurement.ts")).generateRequisitionPdf(
      snap,
      org as never,
      opts as never,
    ),
};

const RFQ_FORBIDDEN_BLOCKS = new Set(["totals"]);
const RFQ_FORBIDDEN_TABLE_PRESETS = new Set(["line_items"]);
const RFQ_FORBIDDEN_PARTY_ROLES = new Set(["billTo", "customer", "vendor"]);

export function assertRfqTemplateContract(template: ResolvedTemplate, blocks: AstBlock[]): void {
  if (template.kind_code !== "purchases.rfq") return;
  const layout = (template.ast as unknown as Record<string, unknown>)["layout"];
  if (layout !== "solicitation") {
    throw new Error("rfq_template_contract: layout must be solicitation");
  }
  for (const block of blocks) {
    if (RFQ_FORBIDDEN_BLOCKS.has(block.type)) {
      throw new Error(`rfq_template_contract: forbidden block ${block.type}`);
    }
    if (block.type === "table" && RFQ_FORBIDDEN_TABLE_PRESETS.has(block.preset)) {
      throw new Error(`rfq_template_contract: forbidden table preset ${block.preset}`);
    }
    if (block.type === "party" && RFQ_FORBIDDEN_PARTY_ROLES.has(block.role)) {
      throw new Error(`rfq_template_contract: forbidden party role ${block.role}`);
    }
  }
}




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

  assertRfqTemplateContract(args.template, args.blocks);

  const statementLayout = STATEMENT_LAYOUTS[args.template.kind_code];
  if (statementLayout) return await statementLayout(snap);

  const procurementLayout = PROCUREMENT_LAYOUTS[args.template.kind_code];
  if (procurementLayout) {
    return await procurementLayout(
      snap,
      (snap["organization"] as unknown) ?? (args.context.business as unknown) ?? null,
      { paperFormat: mediaClassToPaper(args.template.media_class) },
    );
  }



  if (STATEMENT_KIND_CODES.has(args.template.kind_code)) {
    const statementData = {
      ...snap,
      id: args.context.document.id,
      organization:
        (snap["organization"] as unknown) ??
        (args.context.business as unknown) ??
        null,
    } as unknown as Parameters<typeof generateStatementPdf>[0];
    return await generateStatementPdf(
      statementData,
      {},
      // A4-only by construction: never forward a thermal paper token.
      { paperFormat: mediaClassToPaper(args.template.media_class) } as
        Parameters<typeof generateStatementPdf>[2],
    );
  }

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
  // `media_class` is the ONLY source of the native medium — never the
  // document kind. `sales.payment_receipt` is an A4 document that happens
  // to be called a receipt; `pos.receipt_customer` is thermal_80.
  const impliesThermal = String(args.template.media_class ?? "")
    .toLowerCase()
    .startsWith("thermal");
  const defaultPaper = impliesThermal
    ? String(rs?.["paper_size"] ?? "80mm").toLowerCase()
    : "";
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



  // Non-thermal: the resolved geometry is ALWAYS explicit from here on.
  // The coordinate renderer must never have to guess (and must never fall
  // back to inferring thermal from the document kind — a payment receipt
  // is an A4 archive document that happens to be called a receipt).
  const nativePaper = mediaClassToPaper(args.template.media_class);
  const resolvedPaper = paperToken || nativePaper;
  const rendererOptions = {
    ...((args.context.options as Record<string, unknown>) ?? {}),
    paper_format: resolvedPaper,
    paperFormat: resolvedPaper,
  };

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
    rendererOptions as Parameters<typeof generateDocumentPdf>[2],
  );
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
}

/**
 * Native archive geometry for a template's medium. `media_class` values
 * carry orientation suffixes in the DB (`a4_portrait`, `a4_landscape`),
 * which the paper preset does not model — orientation is a separate knob.
 */
function mediaClassToPaper(mediaClass: string | null | undefined): string {
  const m = String(mediaClass ?? "").toLowerCase();
  if (m.startsWith("letter")) return "letter";
  if (m.startsWith("a5")) return "a5";
  return "a4";
}

/**
 * Procurement document layouts — solicitation (RFQ) and internal
 * requisition.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `generateDocumentPdf` draws a *priced commercial document*: recipient
 * block labelled for a payer, a Qty / Unit price / Tax / Line total
 * table, and a totals ladder. Routing a Request for Quotation through it
 * produces an invoice with its money columns zeroed — the same defect
 * that once made customer statements render as invoices with an empty
 * item table (see `renderers/pdf.ts::STATEMENT_KIND_CODES`).
 *
 * Neither of these documents is a claim for money:
 *   - An RFQ *asks* a supplier to state a price. Printing a price column
 *     is factually wrong, and `rfq_items.target_price` is the buyer's
 *     internal ceiling that must never reach a supplier.
 *   - A requisition is an internal demand record. It has no counterparty
 *     at all, so it has no recipient block and is never supplier-facing.
 *
 * Both layouts are therefore drawn from the same PdfBuilder primitives as
 * every other document — no second renderer, no pdf-lib in the app tree —
 * but with their own information architecture.
 */

import {
  PdfBuilder,
  drawBrandedHeader,
  embedLogo,
  drawPageNumber,
  drawFinalFooter,
  drawDataTable,
  drawNotesBlock,
  resolveTypography,
  theme,
  type PaperPreset,
  type PaperSpec,
} from "../index.ts";
import { fetchLogoBytes } from "../../branding/index.ts";
import type { OrganizationBranding } from "../../branding/index.ts";
import { formatDate } from "../../format/index.ts";

export interface ProcurementRenderOptions {
  paperFormat?: PaperPreset | PaperSpec;
  orientation?: "portrait" | "landscape";
}

type Snapshot = Record<string, unknown>;

// ── shared helpers ────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function date(v: unknown): string | null {
  const s = str(v);
  return s ? formatDate(s) : null;
}

/**
 * These layouts describe requirements and internal demand — never a
 * remittance. A thermal roll cannot carry a specification column, and a
 * requisition is an approval artefact that has to be filed. Refuse rather
 * than silently emit an unreadable document.
 */
function assertSheetPaper(kind: string, options: ProcurementRenderOptions): void {
  const paper = String(options.paperFormat ?? "").toLowerCase();
  if (paper === "40mm" || paper === "58mm" || paper === "80mm") {
    throw new Error(
      `${kind} invoked with thermal paper "${paper}". Procurement solicitation ` +
        `and requisition documents are sheet-only by construction.`,
    );
  }
}

async function startDocument(args: {
  title: string;
  subtitle?: string | null;
  organization?: OrganizationBranding | null;
  companyName?: string | null;
  options: ProcurementRenderOptions;
}): Promise<PdfBuilder> {
  const typography = resolveTypography("operational");
  const builder = await PdfBuilder.create({
    orientation: args.options.orientation ?? "portrait",
    paperFormat: args.options.paperFormat ?? "a4",
    margin: typography.pageMargin,
    bottomMargin: typography.pageMargin,
  });

  const logoBytes = args.organization?.logo_url
    ? await fetchLogoBytes(args.organization.logo_url)
    : null;
  const logo = await embedLogo(builder, logoBytes);

  builder.onNewPage = (page) => {
    drawPageNumber(builder, page, typography);
    const drawn = drawBrandedHeader(builder, page, {
      title: args.title,
      dateRange: args.subtitle ?? undefined,
      organization: args.organization ?? null,
      companyName: args.companyName ?? args.organization?.name,
      logo,
      typography,
    });
    return drawn.bodyY;
  };

  builder.newPage();
  return builder;
}

/**
 * Two-column label/value grid. Both procurement documents lead with a
 * block of facts rather than a "Bill To" — the identifying facts ARE the
 * document, and there is no payer to address.
 */
function drawFactsGrid(
  builder: PdfBuilder,
  title: string,
  facts: Array<[string, string | null]>,
): void {
  const present = facts.filter((f): f[1] is string => Boolean(f[1])) as Array<[string, string]>;
  if (present.length === 0) return;

  const { state, fontRegular, fontBold } = builder;
  const { margin, contentWidth } = state;
  const colWidth = contentWidth / 2;
  const rows = Math.ceil(present.length / 2);

  builder.ensureSpace(18 + rows * 13 + 8);
  const page = builder.page;

  page.drawText(title, {
    x: margin,
    y: builder.y,
    size: theme.size.sectionLabel,
    font: fontBold,
    color: theme.color.text,
  });
  builder.y -= 15;

  const top = builder.y;
  present.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = margin + col * colWidth;
    const y = top - row * 13;
    page.drawText(`${label}:`, {
      x,
      y,
      size: 8,
      font: fontBold,
      color: theme.color.medGray,
    });
    page.drawText(value, {
      x: x + 108,
      y,
      size: 8.5,
      font: fontRegular,
      color: theme.color.text,
    });
  });

  builder.y = top - rows * 13 - 10;
}

function drawPartyBlock(
  builder: PdfBuilder,
  label: string,
  party: Record<string, unknown> | null | undefined,
): void {
  if (!party) return;
  const lines = [
    str(party["address_line1"]),
    [str(party["city"]), str(party["state"]), str(party["postal_code"])]
      .filter(Boolean)
      .join(", ") || null,
    str(party["country"]),
    str(party["email"]),
    str(party["phone"]),
  ].filter((l): l is string => Boolean(l));

  const name = str(party["name"]);
  if (!name && lines.length === 0) return;

  builder.ensureSpace(20 + (lines.length + 1) * 12);
  const page = builder.page;
  const { margin } = builder.state;

  page.drawText(label, {
    x: margin,
    y: builder.y,
    size: theme.size.sectionLabel,
    font: builder.fontBold,
    color: theme.color.text,
  });
  builder.y -= 14;

  if (name) {
    page.drawText(name, {
      x: margin,
      y: builder.y,
      size: theme.size.recipientName,
      font: builder.fontBold,
      color: theme.color.text,
    });
    builder.y -= 13;
  }
  for (const line of lines) {
    page.drawText(line, {
      x: margin,
      y: builder.y,
      size: theme.size.recipientLine,
      font: builder.fontRegular,
      color: theme.color.medGray,
    });
    builder.y -= 11;
  }
  builder.y -= 8;
}

// ── RFQ / solicitation ────────────────────────────────────────────────

/**
 * Request for Quotation.
 *
 * Information architecture: WHO is invited, WHAT is required, BY WHEN it
 * must be delivered, and HOW to respond. There is deliberately no price,
 * tax, discount or total anywhere in this layout — the supplier supplies
 * the commercial terms, the buyer supplies the requirement.
 */
export async function generateSolicitationPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: ProcurementRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper("generateSolicitationPdf", options);

  const number = str(snapshot["document_number"]) ?? "";
  const revision = str(snapshot["revision"]);
  const revisionLabel = revision ? `Rev ${revision}` : null;
  const subtitle = [number, revisionLabel].filter(Boolean).join("  ·  ") || null;

  const builder = await startDocument({
    title: str(snapshot["document_type_label"]) ?? "REQUEST FOR QUOTATION",
    subtitle,
    organization,
    companyName: str(snapshot["business_name"]),
    options,
  });

  drawFactsGrid(builder, "Solicitation", [
    ["RFQ number", number || null],
    ["Revision", revision],
    ["Issue date", date(snapshot["issue_date"])],
    ["Response deadline", date(snapshot["response_deadline"])],
    ["Required by", date(snapshot["required_by_date"])],
    ["Quote currency", str(snapshot["currency"])],
    ["Buyer contact", str(snapshot["buyer_contact_name"])],
    ["Buyer email", str(snapshot["buyer_contact_email"])],
  ]);

  drawPartyBlock(
    builder,
    "Invited Supplier:",
    (snapshot["supplier"] ?? snapshot["contact"]) as Record<string, unknown> | null,
  );

  const deliveryLocation = str(snapshot["delivery_location"]);
  if (deliveryLocation) {
    drawNotesBlock(builder, builder.page, {
      title: "Delivery Location",
      body: deliveryLocation,
    });
  }

  const items = Array.isArray(snapshot["items"]) ? (snapshot["items"] as Snapshot[]) : [];
  drawDataTable(builder, {
    columns: [
      { key: "line", header: "#", width: 4, align: "right" },
      { key: "sku", header: "Item code", width: 13, align: "left" },
      { key: "description", header: "Description", width: 28, align: "left" },
      { key: "specification", header: "Specification", width: 26, align: "left" },
      { key: "quantity", header: "Qty", width: 9, format: "number", align: "right" },
      { key: "uom", header: "UOM", width: 8, align: "left" },
      { key: "required_by", header: "Required by", width: 12, align: "left" },
    ],
    rows: items.map((item, idx) => ({
      line: idx + 1,
      sku: str(item["sku"]) ?? "",
      description: str(item["description"]) ?? "",
      specification: str(item["specification"]) ?? "",
      quantity: num(item["quantity"]),
      uom: str(item["unit_of_measure"]) ?? "",
      required_by: date(item["required_by_date"]) ?? "",
    })),
  });

  builder.y -= 10;

  const responseInstructions = str(snapshot["response_instructions"]);
  if (responseInstructions) {
    drawNotesBlock(builder, builder.page, {
      title: "How to Respond",
      body: responseInstructions,
    });
  }

  const commercial = str(snapshot["commercial_requirements"]);
  if (commercial) {
    drawNotesBlock(builder, builder.page, {
      title: "Commercial Requirements",
      body: commercial,
    });
  }

  const notes = str(snapshot["notes"]);
  if (notes) {
    drawNotesBlock(builder, builder.page, { title: "Notes", body: notes });
  }

  const terms = str(snapshot["terms"]);
  if (terms) {
    drawNotesBlock(builder, builder.page, { title: "Terms & Conditions", body: terms });
  }

  drawFinalFooter(builder, builder.page, {
    footerNote:
      "This is a request for quotation. It is not a purchase order and places " +
      "the issuing organisation under no obligation to purchase.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

// ── Purchase requisition ──────────────────────────────────────────────

/**
 * Internal purchase requisition.
 *
 * Audience is internal only: the approver, the procurement reviewer and
 * the auditor. It carries the demand, its justification, its cost
 * allocation and the approval trail. It has no counterparty block and no
 * money — a requisition states a need, not a price, and the kind is
 * registered without an `email` intent so it cannot be sent to a supplier.
 */
export async function generateRequisitionPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: ProcurementRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper("generateRequisitionPdf", options);

  const number = str(snapshot["document_number"]) ?? "";
  const revision = str(snapshot["revision"]);
  const subtitle = [number, revision ? `Rev ${revision}` : null, "INTERNAL"]
    .filter(Boolean)
    .join("  ·  ");

  const builder = await startDocument({
    title: str(snapshot["document_type_label"]) ?? "PURCHASE REQUISITION",
    subtitle,
    organization,
    companyName: str(snapshot["business_name"]),
    options,
  });

  drawFactsGrid(builder, "Request", [
    ["Requisition number", number || null],
    ["Revision", revision],
    ["Status", str(snapshot["status"])],
    ["Raised on", date(snapshot["issue_date"])],
    ["Needed by", date(snapshot["need_by_date"])],
    ["Requested by", str(snapshot["requester_name"])],
    ["Department / cost centre", str(snapshot["cost_center"])],
    ["Project", str(snapshot["project_name"])],
    ["Analytic account", str(snapshot["analytic_account_name"])],
    ["Deliver to", str(snapshot["destination"])],
  ]);

  const justification = str(snapshot["justification"]);
  if (justification) {
    drawNotesBlock(builder, builder.page, {
      title: "Justification",
      body: justification,
    });
  }

  const items = Array.isArray(snapshot["items"]) ? (snapshot["items"] as Snapshot[]) : [];
  drawDataTable(builder, {
    columns: [
      { key: "line", header: "#", width: 4, align: "right" },
      { key: "sku", header: "Item code", width: 13, align: "left" },
      { key: "description", header: "Description", width: 31, align: "left" },
      { key: "quantity", header: "Requested", width: 11, format: "number", align: "right" },
      { key: "uom", header: "UOM", width: 8, align: "left" },
      { key: "ordered", header: "Ordered", width: 10, format: "number", align: "right" },
      { key: "outstanding", header: "Outstanding", width: 11, format: "number", align: "right" },
      { key: "need_by", header: "Need by", width: 12, align: "left" },
    ],
    rows: items.map((item, idx) => ({
      line: idx + 1,
      sku: str(item["sku"]) ?? "",
      description: str(item["description"]) ?? "",
      quantity: num(item["quantity"]),
      uom: str(item["unit_of_measure"]) ?? "",
      ordered: num(item["quantity_ordered"]),
      // Server-owned rollup value; the layout never recomputes demand.
      outstanding: num(item["quantity_outstanding"]),
      need_by: date(item["need_by_date"]) ?? "",
    })),
  });

  builder.y -= 10;

  const approvals = Array.isArray(snapshot["approvals"])
    ? (snapshot["approvals"] as Snapshot[])
    : [];
  if (approvals.length > 0) {
    builder.ensureSpace(40);
    builder.page.drawText("Approval Trail", {
      x: builder.state.margin,
      y: builder.y,
      size: theme.size.sectionLabel,
      font: builder.fontBold,
      color: theme.color.text,
    });
    builder.y -= 16;
    drawDataTable(builder, {
      columns: [
        { key: "step", header: "Step", width: 10, align: "left" },
        { key: "approver", header: "Approver", width: 26, align: "left" },
        { key: "decision", header: "Decision", width: 14, align: "left" },
        { key: "decided_at", header: "Date", width: 14, align: "left" },
        { key: "comment", header: "Comment", width: 36, align: "left" },
      ],
      rows: approvals.map((a, idx) => ({
        step: str(a["step"]) ?? String(idx + 1),
        approver: str(a["approver_name"]) ?? "",
        decision: str(a["decision"]) ?? "",
        decided_at: date(a["decided_at"]) ?? "",
        comment: str(a["comment"]) ?? "",
      })),
    });
    builder.y -= 10;
  }

  const notes = str(snapshot["notes"]);
  if (notes) {
    drawNotesBlock(builder, builder.page, { title: "Notes", body: notes });
  }

  drawFinalFooter(builder, builder.page, {
    footerNote:
      "Internal procurement document — for approval and audit use only. " +
      "Not for distribution to suppliers.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

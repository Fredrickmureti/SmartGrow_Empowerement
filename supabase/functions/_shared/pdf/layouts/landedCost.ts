/**
 * Landed Cost Voucher layout (`purchases.landed_cost_voucher`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `generateDocumentPdf` draws priced commercial paper: a "Bill To"
 * recipient, a Qty / Unit price / Tax / Line total ladder and a balance
 * due. A landed cost voucher has none of that. It is internal costing
 * evidence with three distinct tables — the charges captured, the receipts
 * they were spread across, and the resulting per-product apportionment —
 * plus a capitalised / expensed control that an auditor reads against the
 * general ledger posting.
 *
 * Routing it through the commercial renderer would print an invoice
 * addressed to nobody with an empty item table: exactly the defect the
 * journal voucher layout exists to prevent.
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

export interface LandedCostRenderOptions {
  paperFormat?: PaperPreset | PaperSpec;
  orientation?: "portrait" | "landscape";
}

type Snapshot = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`landed_cost_numeric_invalid:${String(v)}`);
  return n;
}

function date(v: unknown): string | null {
  const s = str(v);
  return s ? formatDate(s) : null;
}

function dateTime(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const iso = d.toISOString();
  return `${formatDate(iso.slice(0, 10))} ${iso.slice(11, 16)}`;
}

function rows(snapshot: Snapshot, key: string): Snapshot[] {
  const v = snapshot[key];
  return Array.isArray(v) ? (v as Snapshot[]) : [];
}

/**
 * A costing voucher carries three tables and a signature strip. None of
 * that survives an 80 mm roll, and an unreadable audit artefact is worse
 * than a refusal.
 */
function assertSheetPaper(options: LandedCostRenderOptions): void {
  const paper = String(options.paperFormat ?? "").toLowerCase();
  if (paper === "40mm" || paper === "58mm" || paper === "80mm") {
    throw new Error(
      `generateLandedCostVoucherPdf invoked with thermal paper "${paper}". ` +
        `Landed cost vouchers are sheet-only by construction.`,
    );
  }
}

function drawFactsGrid(
  builder: PdfBuilder,
  title: string,
  facts: Array<[string, string | null]>,
): void {
  const present = facts.filter((f) => Boolean(f[1])) as Array<[string, string]>;
  if (present.length === 0) return;

  const { state, fontRegular, fontBold } = builder;
  const { margin, contentWidth } = state;
  const colWidth = contentWidth / 2;
  const rowCount = Math.ceil(present.length / 2);

  builder.ensureSpace(18 + rowCount * 13 + 8);
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
      x: x + 118,
      y,
      size: 8.5,
      font: fontRegular,
      color: theme.color.text,
    });
  });

  builder.y = top - rowCount * 13 - 10;
}

function drawSectionLabel(builder: PdfBuilder, label: string): void {
  builder.ensureSpace(30);
  builder.page.drawText(label, {
    x: builder.state.margin,
    y: builder.y,
    size: theme.size.sectionLabel,
    font: builder.fontBold,
    color: theme.color.text,
  });
  builder.y -= 16;
}

/**
 * Costing evidence is only evidence once someone owns it, so the three
 * roles are always printed — filled where the system knows the actor,
 * blank-ruled where it does not.
 */
function drawSignatureStrip(
  builder: PdfBuilder,
  slots: Array<[string, string | null]>,
): void {
  builder.ensureSpace(66);
  const { margin, contentWidth } = builder.state;
  const colWidth = contentWidth / slots.length;
  const page = builder.page;
  const top = builder.y;

  slots.forEach(([role, name], i) => {
    const x = margin + i * colWidth;
    page.drawText(role.toUpperCase(), {
      x,
      y: top,
      size: 7.5,
      font: builder.fontBold,
      color: theme.color.medGray,
    });
    if (name) {
      page.drawText(name, {
        x,
        y: top - 14,
        size: 8.5,
        font: builder.fontRegular,
        color: theme.color.text,
      });
    }
    page.drawLine({
      start: { x, y: top - 30 },
      end: { x: x + colWidth - 18, y: top - 30 },
      thickness: 0.5,
      color: theme.color.medGray,
    });
    page.drawText("Signature / Date", {
      x,
      y: top - 42,
      size: 7,
      font: builder.fontRegular,
      color: theme.color.medGray,
    });
  });

  builder.y = top - 56;
}

export async function generateLandedCostVoucherPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: LandedCostRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper(options);

  const number = str(snapshot["document_number"]) ?? "";
  const status = str(snapshot["status"]);
  const isDraft = snapshot["is_draft"] === true;
  const currency = str(snapshot["currency"]) ?? "";
  const baseCurrency = str(snapshot["base_currency"]);
  const subtitle = [number, status ? status.toUpperCase() : null, "INTERNAL"]
    .filter(Boolean)
    .join("  ·  ");

  const typography = resolveTypography("ledger");
  const builder = await PdfBuilder.create({
    orientation: options.orientation ?? "portrait",
    paperFormat: options.paperFormat ?? "a4",
    margin: typography.pageMargin,
    bottomMargin: typography.pageMargin,
  });

  const logoBytes = organization?.logo_url ? await fetchLogoBytes(organization.logo_url) : null;
  const logo = await embedLogo(builder, logoBytes);

  builder.onNewPage = (page) => {
    drawPageNumber(builder, page, typography);
    const drawn = drawBrandedHeader(builder, page, {
      title: str(snapshot["document_type_label"]) ?? "LANDED COST VOUCHER",
      dateRange: subtitle,
      organization: organization ?? null,
      companyName: str(snapshot["business_name"]) ?? organization?.name,
      logo,
      typography,
    });
    return drawn.bodyY;
  };

  builder.newPage();

  const rate = snapshot["exchange_rate"];

  drawFactsGrid(builder, "Shipment", [
    ["Voucher number", number || null],
    ["Status", status ? status.toUpperCase() : null],
    ["Voucher date", date(snapshot["issue_date"])],
    ["Posting date", date(snapshot["posting_date"])],
    ["Shipment reference", str(snapshot["shipment_reference"])],
    ["Default basis", str(snapshot["default_basis"])],
    ["Charge currency", currency || null],
    [
      "Rate to base",
      rate === null || rate === undefined
        ? null
        : `${num(rate)}${
            baseCurrency && baseCurrency !== currency ? ` ${currency}/${baseCurrency}` : ""
          }`,
    ],
    ["Rate date", date(snapshot["exchange_rate_date"])],
    ["Journal entry", str(snapshot["journal_entry_number"])],
    ["Reversal entry", str(snapshot["reversal_journal_entry_number"])],
    ["Reversal reason", str(snapshot["reversal_reason"])],
  ]);

  const notes = str(snapshot["notes"]);
  if (notes) {
    drawNotesBlock(builder, builder.page, { title: "Notes", body: notes });
  }

  /* ---------------------------------------------------------------- *
   * Charges captured on the shipment
   * ---------------------------------------------------------------- */
  const charges = rows(snapshot, "charges");
  drawSectionLabel(builder, "Charges");
  drawDataTable(builder, {
    columns: [
      { key: "line", header: "#", width: 3.5, align: "right" as const },
      { key: "charge", header: "Charge", width: 20, align: "left" as const },
      { key: "description", header: "Description", width: 24, align: "left" as const },
      { key: "basis", header: "Basis", width: 10, align: "left" as const },
      { key: "treatment", header: "Treatment", width: 11, align: "left" as const },
      { key: "amount", header: `Amount (${currency})`, width: 15, format: "currency", align: "right" as const },
      {
        key: "base_amount",
        header: baseCurrency ? `Base (${baseCurrency})` : "Base",
        width: 15,
        format: "number",
        align: "right" as const,
      },
    ],
    currency,
    typography,
    rows: [
      ...charges.map((c, idx) => ({
        line: str(c["line"]) ?? String(idx + 1),
        charge: str(c["charge_name"]) ?? "",
        description: str(c["description"]) ?? "",
        basis: str(c["basis"]) ?? "",
        treatment: str(c["treatment"]) ?? "",
        amount: num(c["amount"]),
        base_amount: num(c["base_amount"]) || "",
      })),
      {
        line: "",
        charge: "TOTAL CHARGES",
        description: "",
        basis: "",
        treatment: "",
        amount: num(snapshot["total_amount"]),
        base_amount: num(snapshot["total_base_amount"]) || "",
        _isGrandTotal: true,
      },
    ],
  });

  builder.y -= 8;

  /* ---------------------------------------------------------------- *
   * Receipts the charges were spread across
   * ---------------------------------------------------------------- */
  const scope = rows(snapshot, "scope");
  if (scope.length) {
    drawSectionLabel(builder, "Goods receipts covered");
    drawDataTable(builder, {
      columns: [
        { key: "receipt", header: "Receipt", width: 30, align: "left" as const },
        { key: "receipt_date", header: "Received", width: 30, align: "left" as const },
        { key: "receipt_status", header: "Status", width: 40, align: "left" as const },
      ],
      currency,
      typography,
      rows: scope.map((s) => ({
        receipt: str(s["receipt_number"]) ?? "",
        receipt_date: date(s["receipt_date"]) ?? "",
        receipt_status: str(s["receipt_status"]) ?? "",
      })),
    });
    builder.y -= 8;
  }

  /* ---------------------------------------------------------------- *
   * Per-line apportionment — the heart of the artefact
   * ---------------------------------------------------------------- */
  const allocations = rows(snapshot, "allocations");
  if (allocations.length) {
    drawSectionLabel(builder, "Allocation to received lines");
    drawDataTable(builder, {
      columns: [
        { key: "charge", header: "Charge", width: 15, align: "left" as const },
        { key: "receipt", header: "Receipt", width: 12, align: "left" as const },
        { key: "product", header: "Product", width: 21, align: "left" as const },
        { key: "basis", header: "Basis", width: 9, align: "left" as const },
        { key: "basis_value", header: "Basis value", width: 10, format: "number", align: "right" as const },
        { key: "share", header: "Share", width: 8, align: "right" as const },
        { key: "allocated", header: "Allocated", width: 12, format: "currency", align: "right" as const },
        { key: "capitalised", header: "Capitalised", width: 11, format: "number", align: "right" as const },
        { key: "expensed", header: "Expensed", width: 11, format: "number", align: "right" as const },
      ],
      currency,
      typography,
      rows: [
        ...allocations.map((a) => ({
          charge: str(a["charge"]) ?? "",
          receipt: str(a["receipt_number"]) ?? "",
          product:
            [str(a["product_sku"]), str(a["product_name"])].filter(Boolean).join(" · ") || "",
          basis: `${str(a["basis"]) ?? ""}${a["is_manual"] === true ? " (manual)" : ""}`,
          basis_value: num(a["basis_value"]) || "",
          share: `${(num(a["allocation_ratio"]) * 100).toFixed(2)}%`,
          allocated: num(a["allocated_amount"]),
          capitalised: num(a["capitalized_amount"]) || "",
          expensed: num(a["expensed_amount"]) || "",
        })),
        {
          charge: "TOTAL",
          receipt: "",
          product: "",
          basis: "",
          basis_value: "",
          share: "",
          allocated: allocations.reduce((s, a) => s + num(a["allocated_amount"]), 0),
          capitalised: num(snapshot["capitalized_amount"]) || "",
          expensed: num(snapshot["expensed_amount"]) || "",
          _isGrandTotal: true,
        },
      ],
    });
    builder.y -= 8;
  }

  /* ---------------------------------------------------------------- *
   * Costing control — capitalised + expensed must equal the charges.
   * Printing it is the point of the artefact.
   * ---------------------------------------------------------------- */
  const capitalised = num(snapshot["capitalized_amount"]);
  const expensed = num(snapshot["expensed_amount"]);
  const total = num(snapshot["total_amount"]);
  const reconciles = Math.abs(capitalised + expensed - total) < 0.005;

  drawFactsGrid(builder, "Costing control", [
    ["Capitalised to inventory", `${currency} ${capitalised.toFixed(2)}`],
    ["Expensed to cost of sales", `${currency} ${expensed.toFixed(2)}`],
    ["Total charges", `${currency} ${total.toFixed(2)}`],
    [
      "Control",
      reconciles
        ? "Capitalised + expensed equals total charges"
        : "OUT OF BALANCE — capitalised + expensed does not equal total charges",
    ],
  ]);

  const trail = rows(snapshot, "audit_trail");
  if (trail.length) {
    drawSectionLabel(builder, "Audit trail");
    drawDataTable(builder, {
      columns: [
        { key: "event", header: "Event", width: 30, align: "left" as const },
        { key: "actor", header: "By", width: 40, align: "left" as const },
        { key: "at", header: "When", width: 30, align: "left" as const },
      ],
      currency,
      typography,
      rows: trail.map((e) => ({
        event: str(e["event"]) ?? "",
        actor: str(e["actor"]) ?? "",
        at: dateTime(e["at"]) ?? "",
      })),
    });
    builder.y -= 8;
  }

  const byEvent = new Map<string, string | null>();
  for (const e of trail) byEvent.set(String(e["event"] ?? ""), str(e["actor"]));
  builder.ensureSpace(96);
  drawSectionLabel(builder, "Authorisation");
  drawSignatureStrip(builder, [
    ["Prepared by", byEvent.get("Prepared") ?? null],
    ["Allocated by", byEvent.get("Allocated") ?? null],
    ["Approved by", byEvent.get("Posted") ?? null],
  ]);

  drawFinalFooter(builder, builder.page, {
    footerNote: isDraft
      ? "DRAFT — these charges have not been posted. No unit cost has been " +
        "uplifted and no ledger entry exists for this voucher."
      : "Internal costing voucher. Retained as supporting evidence for the " +
        "inventory revaluation and general ledger posting identified above.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

export default generateLandedCostVoucherPdf;

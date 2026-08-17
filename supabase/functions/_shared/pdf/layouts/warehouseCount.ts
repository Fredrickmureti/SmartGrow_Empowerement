/**
 * Cycle count layouts (`wms.count_sheet`, `wms.count_sheet_blind`,
 * `wms.count_variance_report`, `wms.count_audit_report`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `generateDocumentPdf` draws a priced commercial document: a "Bill To"
 * recipient, a Qty / Unit price / Tax / Line total ladder and a
 * "Balance Due". A cycle count has none of those things — no counterparty,
 * no currency, no prices. Routed through the commercial renderer it came
 * out as an invoice addressed to nobody with an empty item table, which is
 * exactly the defect statements, RFQs and journal vouchers already have
 * dedicated layouts for.
 *
 * Two layouts live here because a count produces two kinds of paper:
 *
 *   • the SHEET a counter carries into the aisle (write-in column), and
 *   • the REPORT a supervisor and an auditor read afterwards.
 *
 * The blind sheet is drawn by the same sheet routine, but its snapshot is
 * built by a separate builder that never reads a quantity, so no
 * configuration mistake here can put an expected quantity on a blind sheet.
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

export interface CountRenderOptions {
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
  return Number.isFinite(n) ? n : 0;
}

function date(v: unknown): string | null {
  const s = str(v);
  return s ? formatDate(s.slice(0, 10)) : null;
}

function humanise(v: unknown): string | null {
  const s = str(v)?.replace(/_/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/**
 * A count sheet is written on by hand and a difference report is filed. An
 * 80 mm roll can carry neither, and unreadable warehouse paper is worse
 * than a visible refusal.
 */
function assertSheetPaper(options: CountRenderOptions, what: string): void {
  const paper = String(options.paperFormat ?? "").toLowerCase();
  if (paper === "40mm" || paper === "58mm" || paper === "80mm") {
    throw new Error(
      `${what} invoked with thermal paper "${paper}". Cycle count paperwork is sheet-only.`,
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
      x: x + 112,
      y,
      size: 8.5,
      font: fontRegular,
      color: theme.color.text,
    });
  });

  builder.y = top - rows * 13 - 10;
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

/** Counter / supervisor accountability. A count is evidence only once signed. */
interface SignatureSlot {
  role: string;
  name?: string | null;
  at?: string | null;
}

function drawSignatureStrip(
  builder: PdfBuilder,
  slots: Array<string | SignatureSlot>,
): void {
  builder.ensureSpace(66);
  const { margin, contentWidth } = builder.state;
  const entries: SignatureSlot[] = slots.map((s) =>
    typeof s === "string" ? { role: s } : s,
  );
  const colWidth = contentWidth / entries.length;
  const page = builder.page;
  const top = builder.y;

  entries.forEach((entry, i) => {
    const x = margin + i * colWidth;
    page.drawText(entry.role.toUpperCase(), {
      x,
      y: top,
      size: 7.5,
      font: builder.fontBold,
      color: theme.color.medGray,
    });

    // A recorded actor is printed above the rule; an unrecorded one leaves the
    // rule blank so nobody is credited with a sign-off they did not make.
    if (entry.name) {
      page.drawText(entry.name.slice(0, 34), {
        x,
        y: top - 18,
        size: 8.5,
        font: builder.fontBold,
        color: theme.color.text,
      });
      if (entry.at) {
        page.drawText(String(entry.at).slice(0, 10), {
          x,
          y: top - 27,
          size: 7,
          font: builder.fontRegular,
          color: theme.color.medGray,
        });
      }
    }

    page.drawLine({
      start: { x, y: top - 30 },
      end: { x: x + colWidth - 18, y: top - 30 },
      thickness: 0.5,
      color: theme.color.medGray,
    });
    page.drawText(entry.name ? "Recorded in the system" : "Name / Signature / Date", {
      x,
      y: top - 42,
      size: 7,
      font: builder.fontRegular,
      color: theme.color.medGray,
    });
  });

  builder.y = top - 56;
}

/**
 * Sign-off slots for an evidence document, filled from the recorded actors.
 * Under solo governance the same person legitimately fills several roles —
 * that is what happened, and the paper says so rather than inventing people.
 */
function signatureSlots(snapshot: Snapshot, isAudit: boolean): SignatureSlot[] {
  const so = (snapshot["signoffs"] ?? null) as Snapshot | null;
  const actor = (key: string): { name?: string | null; at?: string | null } => {
    const a = (so?.[key] ?? null) as Snapshot | null;
    return { name: a ? str(a["name"]) : null, at: a ? str(a["at"]) : null };
  };
  const counters = Array.isArray(so?.["counted_by"]) ? (so["counted_by"] as Snapshot[]) : [];
  const counterNames = counters
    .map((c) => str(c["name"]))
    .filter((n): n is string => Boolean(n));

  if (isAudit) {
    return [
      { role: "Reviewed by", ...actor("reviewed_by") },
      { role: "Audited by" },
    ];
  }
  return [
    { role: "Counted by", name: counterNames.join(", ") || null },
    { role: "Reviewed by", ...actor("reviewed_by") },
    { role: "Approved by", ...actor("approved_by") },
  ];
}




function headerFactRows(snapshot: Snapshot): Array<[string, string | null]> {
  return [
    ["Count number", str(snapshot["document_number"])],
    ["Status", humanise(snapshot["status"])],
    ["Warehouse", str(snapshot["warehouse_name"]) ?? str(snapshot["warehouse_code"])],
    ["How it was chosen", str(snapshot["strategy_label"])],
    ["Started", date(snapshot["counted_on"])],
    ["Posted", date(snapshot["posted_at"])],
    ["Counting style", snapshot["is_blind"] === true ? "Blind (no expected quantity shown)" : "Standard"],
    ["Stock count reference", str(snapshot["linked_count_number"])],
    ["Lines", snapshot["line_count"] === undefined ? null : String(num(snapshot["line_count"]))],
  ];
}

async function startDocument(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: CountRenderOptions,
  fallbackTitle: string,
  profile: "ledger" | "operational",
) {
  const number = str(snapshot["document_number"]) ?? "";
  const status = humanise(snapshot["status"]);
  const subtitle = [number, status ? status.toUpperCase() : null, "WAREHOUSE"]
    .filter(Boolean)
    .join("  ·  ");

  const typography = resolveTypography(profile);
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
      title: str(snapshot["document_type_label"]) ?? fallbackTitle,
      dateRange: subtitle,
      organization: organization ?? null,
      companyName: str(snapshot["business_name"]) ?? organization?.name,
      logo,
      typography,
    });
    return drawn.bodyY;
  };

  builder.newPage();
  return { builder, typography };
}

/**
 * The walk-the-aisle worksheet. `blind: true` snapshots simply arrive
 * without an `expected` value on any row, so the expected column is
 * omitted — the sheet cannot show what it was never given.
 */
export async function generateCountSheetPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: CountRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper(options, "generateCountSheetPdf");
  const blind = snapshot["blind"] === true;
  const { builder, typography } = await startDocument(
    snapshot,
    organization,
    options,
    blind ? "BLIND COUNT SHEET" : "COUNT SHEET",
    "operational",
  );

  drawFactsGrid(builder, "Count", headerFactRows(snapshot));

  const instructions = str(snapshot["instructions"]);
  if (instructions) {
    drawNotesBlock(builder, builder.page, { title: "How to use this sheet", body: instructions });
  }

  const rows = Array.isArray(snapshot["count_lines"]) ? (snapshot["count_lines"] as Snapshot[]) : [];
  const hasDetail = rows.some((r) => Boolean(str(r["detail"]) || str(r["lot"]) || str(r["expiry"])));

  drawSectionLabel(builder, blind ? "Bins to count" : "Bins to count (expected quantity shown)");
  drawDataTable(builder, {
    typography,
    columns: [
      { key: "line_no", header: "#", width: 4, align: "right" as const },
      { key: "bin", header: "Bin", width: 14, align: "left" as const },
      { key: "product", header: "Product", width: blind ? 34 : 28, align: "left" as const },
      { key: "sku", header: "Code", width: 12, align: "left" as const },
      ...(hasDetail
        ? [{ key: "detail", header: "Lot / expiry", width: 14, align: "left" as const }]
        : []),
      ...(blind
        ? []
        : [{ key: "expected", header: "Expected", width: 10, format: "number", align: "right" as const }]),
      { key: "counted", header: "Counted", width: hasDetail ? 12 : 18, align: "right" as const },
    ],
    rows: rows.map((r, idx) => ({
      line_no: str(r["line_no"]) ?? String(idx + 1),
      bin: str(r["bin"]) ?? "",
      product: str(r["product"]) ?? "",
      sku: str(r["sku"]) ?? "",
      detail: str(r["detail"]) ?? [str(r["lot"]), str(r["expiry"])].filter(Boolean).join(" · "),
      expected: blind ? "" : num(r["expected"]),
      // Deliberately blank: this column is written on by hand.
      counted: "",
    })),
  });

  builder.y -= 12;
  drawSectionLabel(builder, "Sign off");
  drawSignatureStrip(builder, ["Counted by", "Checked by"]);

  drawFinalFooter(builder, builder.page, {
    footerNote: blind
      ? "Blind count — no expected quantity is printed on this sheet by design. " +
        "Record exactly what is on the shelf; stock is never adjusted from this sheet."
      : "Working document. Stock is adjusted only after the count is submitted, " +
        "reviewed and approved in the system.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

/**
 * Difference report and audit report — same evidentiary frame, different
 * column set, chosen from the snapshot's own document type.
 */
export async function generateCountReportPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: CountRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper(options, "generateCountReportPdf");
  const isAudit = str(snapshot["document_type"]) === "count_audit_report";
  const { builder, typography } = await startDocument(
    snapshot,
    organization,
    options,
    isAudit ? "COUNT AUDIT REPORT" : "COUNT DIFFERENCE REPORT",
    "ledger",
  );

  drawFactsGrid(builder, "Count", headerFactRows(snapshot));

  const summary = (snapshot["summary"] ?? null) as Snapshot | null;
  if (summary) {
    drawFactsGrid(builder, "What the count found", [
      ["Bins in scope", String(num(summary["lines_in_scope"]))],
      ["Bins counted", String(num(summary["lines_counted"]))],
      ["Bins not counted", String(num(summary["lines_not_counted"]))],
      ["Bins that disagreed", String(num(summary["differences"]))],
      ["Awaiting approval", String(num(summary["awaiting_approval"]))],
      ["Recounts requested", String(num(summary["recounts_open"]))],
      ["Units found over", String(num(summary["units_over"]))],
      ["Units found short", String(Math.abs(num(summary["units_short"])))],
    ]);
  }

  const rows = Array.isArray(snapshot["count_lines"]) ? (snapshot["count_lines"] as Snapshot[]) : [];

  drawSectionLabel(builder, isAudit ? "Every counting attempt" : "Differences found");

  if (rows.length === 0) {
    builder.ensureSpace(20);
    builder.page.drawText(
      isAudit
        ? "No counting attempts were recorded for this count."
        : "Every bin counted matched the expected quantity. No differences to report.",
      {
        x: builder.state.margin,
        y: builder.y,
        size: 9,
        font: builder.fontRegular,
        color: theme.color.text,
      },
    );
    builder.y -= 20;
  } else if (isAudit) {
    drawDataTable(builder, {
      typography,
      columns: [
        { key: "line_no", header: "#", width: 3.5, align: "right" as const },
        { key: "bin", header: "Bin", width: 11, align: "left" as const },
        { key: "product", header: "Product", width: 20, align: "left" as const },
        { key: "lot", header: "Lot", width: 8, align: "left" as const },
        { key: "round", header: "Round", width: 5, align: "right" as const },
        { key: "expected", header: "Expected", width: 8, format: "number", align: "right" as const },
        { key: "counted", header: "Counted", width: 8, format: "number", align: "right" as const },
        { key: "difference", header: "Difference", width: 8, format: "number", align: "right" as const },
        { key: "entered", header: "Entered as", width: 10, align: "left" as const },
        { key: "counted_at", header: "When", width: 10, align: "left" as const },
        { key: "outcome", header: "Outcome", width: 16, align: "left" as const },
      ],
      rows: rows.map((r, idx) => ({
        line_no: str(r["line_no"]) ?? String(idx + 1),
        bin: str(r["bin"]) ?? "",
        product: str(r["product"]) ?? "",
        lot: str(r["lot"]) ?? "",
        round: str(r["round"]) ?? "",
        expected: num(r["expected"]),
        counted: r["counted"] === "" ? "" : num(r["counted"]),
        difference: r["difference"] === "" ? "" : num(r["difference"]),
        entered: str(r["entered"]) ?? "",
        counted_at: str(r["counted_at"]) ?? "",
        outcome: [str(r["outcome"]), str(r["superseded"])].filter(Boolean).join(" — "),
      })),
    });
  } else {
    drawDataTable(builder, {
      typography,
      columns: [
        { key: "line_no", header: "#", width: 4, align: "right" as const },
        { key: "bin", header: "Bin", width: 12, align: "left" as const },
        { key: "product", header: "Product", width: 22, align: "left" as const },
        { key: "sku", header: "Code", width: 10, align: "left" as const },
        { key: "expected", header: "Expected", width: 9, format: "number", align: "right" as const },
        { key: "counted", header: "Counted", width: 9, format: "number", align: "right" as const },
        { key: "difference", header: "Difference", width: 9, format: "number", align: "right" as const },
        { key: "reason", header: "Reason given", width: 12, align: "left" as const },
        { key: "outcome", header: "Why it needs review", width: 20, align: "left" as const },
      ],
      rows: rows.map((r, idx) => ({
        line_no: str(r["line_no"]) ?? String(idx + 1),
        bin: str(r["bin"]) ?? "",
        product: str(r["product"]) ?? "",
        sku: str(r["sku"]) ?? "",
        expected: num(r["expected"]),
        counted: num(r["counted"]),
        difference: num(r["difference"]),
        reason: str(r["reason"]) ?? "—",
        outcome: str(r["outcome"]) ?? "",
      })),
    });
  }

  builder.y -= 12;

  const notes = str(snapshot["notes"]);
  if (notes) {
    drawNotesBlock(builder, builder.page, { title: "Count notes", body: notes });
  }

  drawSectionLabel(builder, "Sign off");
  drawSignatureStrip(builder, signatureSlots(snapshot, isAudit));

  const posted = str(snapshot["posted_at"]);
  drawFinalFooter(builder, builder.page, {
    footerNote: isAudit
      ? "Full counting history, including superseded recount rounds. Retained as " +
        "supporting evidence for the stock adjustment raised by this count."
      : posted
        ? "This count has been approved and posted. The differences shown were " +
          "applied to stock through the resulting adjustment."
        : "Differences shown are proposals. Stock changes only once the count is " +
          "approved and the resulting adjustment is posted.",
    includeGeneratedStamp: true,
  });


  return await builder.save();
}
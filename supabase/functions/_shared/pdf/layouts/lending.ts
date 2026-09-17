/**
 * Lending document layouts (`lending.*`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `generateDocumentPdf` draws a priced commercial document: a "Bill To"
 * block, a Qty / Unit price / Tax / Line total ladder and a "Balance Due".
 * None of the four lending artefacts has that anatomy:
 *
 *   • `lending.loan_agreement`     — terms + the full installment plan the
 *                                    borrower signs. No quantities, no tax.
 *   • lending.repayment_schedule` — the installment plan alone, handed to
 *                                    the client and the officer.
 *   • `lending.loan_statement`     — a period ledger of disbursement,
 *                                    repayments and reversals plus the
 *                                    server-owned outstanding position.
 *   • `lending.payment_receipt`    — evidence of one collected payment and
 *                                    how it was allocated across
 *                                    principal / interest / fees / penalty.
 *
 * Every figure drawn here comes from the frozen snapshot, which is itself
 * projected from server-owned state (`mf_loans`, `mf_loan_schedule`,
 * `mf_loan_balances`, `mf_repayments`, `mf_repayment_allocations`). This
 * module computes NO interest, NO arrears and NO allocations — it only sums
 * columns it was handed, and only for the printed total row.
 *
 * All four are sheet-only by construction: a signed contract, an
 * installment plan, a ledger and an allocated receipt each need a table
 * with an account/amount ladder and a signature strip, none of which
 * survives an 80 mm roll. A misconfigured `document_print_policies` row
 * must fail loudly rather than emit unreadable legal paper.
 */

import {
  PdfBuilder,
  drawBrandedHeader,
  embedLogo,
  drawPageNumber,
  drawFinalFooter,
  drawDataTable,
  drawNotesBlock,
  drawSummaryBlock,
  resolveTypography,
  theme,
  type PaperPreset,
  type PaperSpec,
} from "../index.ts";
import { fetchLogoBytes } from "../../branding/index.ts";
import type { OrganizationBranding } from "../../branding/index.ts";
import { formatDate } from "../../format/index.ts";

export interface LendingRenderOptions {
  paperFormat?: PaperPreset | PaperSpec;
  orientation?: "portrait" | "landscape";
}

type Snapshot = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`lending_numeric_invalid:${String(v)}`);
  return n;
}

function date(v: unknown): string | null {
  const s = str(v);
  return s ? formatDate(s.slice(0, 10)) : null;
}

/** "flat_rate" → "Flat rate". */
function humanise(v: unknown): string | null {
  const s = str(v)?.replace(/_/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

function money(amount: unknown, currency: string | null): string {
  const n = num(amount);
  const formatted = n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${formatted}` : formatted;
}

function rows(snapshot: Snapshot, key: string): Snapshot[] {
  const v = snapshot[key];
  return Array.isArray(v) ? (v as Snapshot[]) : [];
}

/**
 * Lending paper is legal / evidentiary and always tabular. Refuse thermal
 * rather than emit a truncated contract or an unreadable schedule.
 */
function assertSheetPaper(kind: string, options: LendingRenderOptions): void {
  const paper = String(options.paperFormat ?? "").toLowerCase();
  if (paper === "40mm" || paper === "58mm" || paper === "80mm") {
    throw new Error(
      `${kind} invoked with thermal paper "${paper}". Lending documents are ` +
        `sheet-only by construction.`,
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
  const lineCount = Math.ceil(present.length / 2);

  builder.ensureSpace(18 + lineCount * 13 + 8);
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

  builder.y = top - lineCount * 13 - 10;
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
 * Signature strip. A lending artefact is only enforceable once the parties
 * own it, so the wells are always ruled — filled where the snapshot knows
 * the actor, blank where it does not.
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

async function startSheet(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: LendingRenderOptions,
  fallbackTitle: string,
): Promise<PdfBuilder> {
  const typography = resolveTypography("operational");
  const builder = await PdfBuilder.create({
    orientation: options.orientation ?? "portrait",
    paperFormat: options.paperFormat ?? "a4",
    margin: typography.pageMargin,
    bottomMargin: typography.pageMargin,
  });

  const logoBytes = organization?.logo_url
    ? await fetchLogoBytes(organization.logo_url)
    : null;
  const logo = await embedLogo(builder, logoBytes);

  const subtitle = [
    str(snapshot["document_number"]),
    str(snapshot["client_name"]),
    date(snapshot["issue_date"]),
  ]
    .filter(Boolean)
    .join("  ·  ");

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
  return builder;
}

function partyFacts(snapshot: Snapshot): Array<[string, string | null]> {
  return [
    ["Client", str(snapshot["client_name"])],
    ["Client number", str(snapshot["client_number"])],
    ["National ID", str(snapshot["client_national_id"])],
    ["Phone", str(snapshot["client_phone"])],
    ["Address", str(snapshot["client_address"])],
    ["Occupation / business", str(snapshot["client_business"])],
    ["Branch", str(snapshot["branch_name"])],
    ["Loan officer", str(snapshot["officer_name"])],
  ];
}

function termFacts(snapshot: Snapshot): Array<[string, string | null]> {
  const currency = str(snapshot["currency"]);
  const rate = snapshot["interest_rate"];
  const period = humanise(snapshot["interest_rate_period"]);
  const grace = num(snapshot["grace_period_installments"]);
  const penalty = num(snapshot["penalty_rate"]);
  return [
    ["Loan number", str(snapshot["loan_number"])],
    ["Product", str(snapshot["product_name"])],
    ["Status", str(snapshot["status"])?.toUpperCase() ?? null],
    ["Principal", money(snapshot["principal"], currency)],
    [
      "Term",
      num(snapshot["term_installments"])
        ? `${num(snapshot["term_installments"])} × ${
          humanise(snapshot["repayment_frequency"]) ?? "installment"
        }`
        : null,
    ],
    ["Interest method", humanise(snapshot["interest_method"])],
    [
      "Interest rate",
      rate === null || rate === undefined
        ? null
        : `${num(rate)}%${period ? ` per ${period.toLowerCase()}` : ""}`,
    ],
    ["Grace installments", grace ? String(grace) : null],
    [
      "Penalty",
      penalty
        ? `${penalty}%${humanise(snapshot["penalty_basis"]) ? ` on ${humanise(snapshot["penalty_basis"])!.toLowerCase()}` : ""}`
        : null,
    ],
    ["Expected disbursement", date(snapshot["expected_disbursement_date"])],
    ["Disbursed on", date(snapshot["disbursed_at"])],
    ["First installment", date(snapshot["first_installment_date"])],
    ["Currency", str(snapshot["currency"])],
    ["Lineage", humanise(snapshot["lineage_kind"])],
  ];
}

/**
 * Installment plan. Drawn identically wherever it appears (agreement,
 * schedule, statement) so the borrower can never be handed two differently
 * shaped versions of the same plan.
 */
function drawScheduleTable(builder: PdfBuilder, snapshot: Snapshot): void {
  const plan = rows(snapshot, "schedule");
  if (plan.length === 0) return;

  const typography = resolveTypography("ledger");
  const hasFees = plan.some((r) => num(r["fees_due"]) !== 0);
  /**
   * Penalty is printed ONLY where an amount was actually assessed and is
   * still outstanding. A penalty rule existing on the product never puts a
   * column on the borrower's schedule.
   */
  const hasPenalty = plan.some((r) => num(r["penalty_due"]) !== 0);
  const totals = (snapshot["schedule_totals"] ?? {}) as Snapshot;
  const currency = str(snapshot["currency"]) ?? undefined;

  drawDataTable(builder, {
    typography,
    currency,
    columns: [
      { key: "no", header: "#", width: 4, align: "right" },
      { key: "due", header: "Due date", width: 12, align: "left" },
      { key: "opening", header: "Opening", width: 13, format: "currency", align: "right" },
      { key: "principal", header: "Principal", width: 13, format: "currency", align: "right" },
      { key: "interest", header: "Interest", width: 13, format: "currency", align: "right" },
      ...(hasFees
        ? [{ key: "fees", header: "Fees", width: 11, format: "currency", align: "right" as const }]
        : []),
      ...(hasPenalty
        ? [{ key: "penalty", header: "Penalty", width: 11, format: "currency", align: "right" as const }]
        : []),
      { key: "total", header: "Installment", width: 14, format: "currency", align: "right" },
      { key: "closing", header: "Closing", width: 14, format: "currency", align: "right" },
    ],
    rows: [
      ...plan.map((r, idx) => ({
        no: String(num(r["installment_no"]) || idx + 1),
        due: date(r["due_date"]) ?? "",
        opening: num(r["opening_balance"]),
        principal: num(r["principal_due"]),
        interest: num(r["interest_due"]),
        fees: num(r["fees_due"]),
        penalty: num(r["penalty_due"]),
        total: num(r["total_due"]),
        closing: num(r["closing_balance"]),
        ...(r["is_grace"] === true ? { due: `${date(r["due_date"]) ?? ""} (grace)` } : {}),
      })),
      {
        no: "",
        due: "TOTAL",
        opening: "",
        principal: num(totals["principal"]),
        interest: num(totals["interest"]),
        fees: num(totals["fees"]),
        penalty: num(totals["penalty"]),
        total: num(totals["total"]),
        closing: "",
        _isGrandTotal: true,
      },
    ],
  });
  builder.y -= 8;
}

/* ------------------------------------------------------------------ */
/* lending.loan_agreement                                              */
/* ------------------------------------------------------------------ */

export async function generateLoanAgreementPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: LendingRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper("generateLoanAgreementPdf", options);
  const builder = await startSheet(snapshot, organization, options, "LOAN AGREEMENT");
  const currency = str(snapshot["currency"]);

  drawFactsGrid(builder, "Lender", [
    ["Institution", str(snapshot["business_legal_name"]) ?? str(snapshot["business_name"])],
    ["Registration", str(snapshot["business_registration"])],
    ["Tax ID", str(snapshot["business_tax_id"])],
    ["Address", str(snapshot["business_address"])],
    ["Phone", str(snapshot["business_phone"])],
    ["Email", str(snapshot["business_email"])],
  ]);
  drawFactsGrid(builder, "Borrower", partyFacts(snapshot));
  drawFactsGrid(builder, "Terms", termFacts(snapshot));

  drawSectionLabel(builder, "Repayment Plan");
  drawScheduleTable(builder, snapshot);

  drawSummaryBlock(builder, builder.page, [
    { label: "Principal", value: money(snapshot["principal"], currency) },
    {
      label: "Interest",
      value: money((snapshot["schedule_totals"] as Snapshot | undefined)?.["interest"], currency),
    },
    {
      label: "Fees",
      value: money((snapshot["schedule_totals"] as Snapshot | undefined)?.["fees"], currency),
    },
    { label: "Total repayable", value: money(snapshot["total_repayable"], currency) },
  ]);

  drawNotesBlock(builder, builder.page, {
    title: "Undertaking",
    body:
      "The borrower acknowledges receipt of the principal stated above and " +
      "undertakes to repay the installments on the dates set out in the " +
      "repayment plan. Late payment attracts the penalty stated in the terms. " +
      "Amounts collected are applied in the order defined by the loan " +
      "product and are evidenced by numbered receipts.",
  });

  drawSectionLabel(builder, "Execution");
  drawSignatureStrip(builder, [
    ["Borrower", str(snapshot["client_name"])],
    ["Witness", null],
    ["For the lender", str(snapshot["officer_name"])],
  ]);

  drawFinalFooter(builder, builder.page, {
    footerNote:
      "Loan agreement. Terms and the repayment plan are as recorded by the " +
      "lender at the date of issue shown above.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

/* ------------------------------------------------------------------ */
/* lending.repayment_schedule                                          */
/* ------------------------------------------------------------------ */

export async function generateRepaymentSchedulePdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: LendingRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper("generateRepaymentSchedulePdf", options);
  const builder = await startSheet(snapshot, organization, options, "REPAYMENT SCHEDULE");
  const currency = str(snapshot["currency"]);

  drawFactsGrid(builder, "Loan", [
    ["Client", str(snapshot["client_name"])],
    ["Client number", str(snapshot["client_number"])],
    ["Loan number", str(snapshot["loan_number"])],
    ["Product", str(snapshot["product_name"])],
    ["Principal", money(snapshot["principal"], currency)],
    ["Disbursed on", date(snapshot["disbursed_at"])],
    ["Branch", str(snapshot["branch_name"])],
    ["Loan officer", str(snapshot["officer_name"])],
  ]);

  drawSectionLabel(builder, "Installments");
  drawScheduleTable(builder, snapshot);

  drawSummaryBlock(builder, builder.page, [
    { label: "Next due date", value: date(snapshot["next_due_date"]) ?? "—" },
    {
      label: "Total scheduled",
      value: money((snapshot["schedule_totals"] as Snapshot | undefined)?.["total"], currency),
    },
    { label: "Outstanding", value: money(snapshot["total_outstanding"], currency) },
  ]);

  drawFinalFooter(builder, builder.page, {
    footerNote:
      "Repayment schedule as at the date of issue. Outstanding balances are " +
      "maintained by the lender and may change with further collections.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

/* ------------------------------------------------------------------ */
/* lending.loan_statement                                              */
/* ------------------------------------------------------------------ */

export async function generateLoanStatementPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: LendingRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper("generateLoanStatementPdf", options);
  const builder = await startSheet(snapshot, organization, options, "LOAN STATEMENT");
  const currency = str(snapshot["currency"]);
  const typography = resolveTypography("ledger");

  drawFactsGrid(builder, "Account", [
    ["Client", str(snapshot["client_name"])],
    ["Client number", str(snapshot["client_number"])],
    ["Loan number", str(snapshot["loan_number"])],
    ["Product", str(snapshot["product_name"])],
    ["Status", str(snapshot["status"])?.toUpperCase() ?? null],
    ["Disbursed on", date(snapshot["disbursed_at"])],
    ["Branch", str(snapshot["branch_name"])],
    ["Loan officer", str(snapshot["officer_name"])],
  ]);

  const txns = rows(snapshot, "transactions");
  drawSectionLabel(builder, "Account Activity");
  if (txns.length === 0) {
    builder.ensureSpace(20);
    builder.page.drawText("No movements recorded on this loan.", {
      x: builder.state.margin,
      y: builder.y,
      size: 8.5,
      font: builder.fontRegular,
      color: theme.color.medGray,
    });
    builder.y -= 18;
  } else {
    const hasPenalty = txns.some((t) => num(t["penalty"]) !== 0);
    drawDataTable(builder, {
      typography,
      currency: currency ?? undefined,
      columns: [
        { key: "date", header: "Date", width: 11, align: "left" },
        { key: "reference", header: "Reference", width: 14, align: "left" },
        { key: "description", header: "Description", width: 21, align: "left" },
        { key: "principal", header: "Principal", width: 13, format: "currency", align: "right" },
        { key: "interest", header: "Interest", width: 12, format: "currency", align: "right" },
        { key: "fees", header: "Fees", width: 11, format: "currency", align: "right" },
        ...(hasPenalty
          ? [{ key: "penalty", header: "Penalty", width: 11, format: "currency", align: "right" as const }]
          : []),
        { key: "amount", header: "Amount", width: 14, format: "currency", align: "right" },
      ],
      rows: txns.map((t) => ({
        date: date(t["date"]) ?? "",
        reference: str(t["reference"]) ?? "",
        description: str(t["description"]) ?? "",
        principal: num(t["principal"]) || "",
        interest: num(t["interest"]) || "",
        fees: num(t["fees"]) || "",
        penalty: num(t["penalty"]) || "",
        amount: num(t["amount"]),
      })),
    });
    builder.y -= 8;
  }

  drawSectionLabel(builder, "Position");
  drawFactsGrid(builder, "Outstanding", [
    ["Principal outstanding", money(snapshot["principal_outstanding"], currency)],
    ["Interest outstanding", money(snapshot["interest_outstanding"], currency)],
    ["Fees outstanding", money(snapshot["fees_outstanding"], currency)],
    ["Total outstanding", money(snapshot["total_outstanding"], currency)],
    ["Total contractual", money(snapshot["total_contractual"], currency)],
    ["Total collected", money(snapshot["total_collected"], currency)],
    ["Amount overdue", money(snapshot["amount_overdue"], currency)],
    [
      "Days past due",
      num(snapshot["days_past_due"]) ? String(num(snapshot["days_past_due"])) : "0",
    ],
    ["Next due date", date(snapshot["next_due_date"])],
  ]);

  drawFinalFooter(builder, builder.page, {
    footerNote:
      "Loan statement. Balances, arrears and allocations are computed and " +
      "maintained by the lender's ledger as at the date of issue.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

/* ------------------------------------------------------------------ */
/* lending.payment_receipt                                             */
/* ------------------------------------------------------------------ */

export async function generateLoanPaymentReceiptPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: LendingRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper("generateLoanPaymentReceiptPdf", options);
  const builder = await startSheet(snapshot, organization, options, "PAYMENT RECEIPT");
  const currency = str(snapshot["currency"]);
  const reversed = str(snapshot["receipt_status"]) === "reversed";

  drawFactsGrid(builder, "Receipt", [
    ["Receipt number", str(snapshot["receipt_number"])],
    ["Paid on", date(snapshot["paid_on"])],
    ["Amount received", money(snapshot["amount"], currency)],
    ["Method", humanise(snapshot["method"])],
    ["Payment reference", str(snapshot["payment_reference"])],
    ["Status", str(snapshot["receipt_status"])?.toUpperCase() ?? null],
    ["Received by", str(snapshot["received_by_name"])],
    ["Branch", str(snapshot["branch_name"])],
  ]);

  drawFactsGrid(builder, "Loan", [
    ["Client", str(snapshot["client_name"])],
    ["Client number", str(snapshot["client_number"])],
    ["Loan number", str(snapshot["loan_number"])],
    ["Product", str(snapshot["product_name"])],
  ]);

  const allocations = rows(snapshot, "allocations");
  if (allocations.length > 0) {
    drawSectionLabel(builder, "Allocation");
    drawDataTable(builder, {
      typography: resolveTypography("operational"),
      currency: currency ?? undefined,
      columns: [
        { key: "installment", header: "Installment", width: 20, align: "left" },
        { key: "component", header: "Applied to", width: 50, align: "left" },
        { key: "amount", header: "Amount", width: 30, format: "currency", align: "right" },
      ],
      rows: [
        ...allocations.map((a) => ({
          installment:
            a["installment_no"] === null || a["installment_no"] === undefined
              ? "—"
              : `#${num(a["installment_no"])}`,
          component: humanise(a["component"]) ?? "Other",
          amount: num(a["amount"]),
        })),
        {
          installment: "",
          component: "TOTAL ALLOCATED",
          amount: allocations.reduce((s, a) => s + num(a["amount"]), 0),
          _isGrandTotal: true,
        },
      ],
    });
    builder.y -= 8;
  }

  drawSummaryBlock(builder, builder.page, [
    { label: "Principal outstanding", value: money(snapshot["principal_outstanding"], currency) },
    { label: "Interest outstanding", value: money(snapshot["interest_outstanding"], currency) },
    { label: "Total outstanding", value: money(snapshot["total_outstanding"], currency) },
    { label: "Next due date", value: date(snapshot["next_due_date"]) ?? "—" },
  ]);

  const reason = str(snapshot["reversal_reason"]);
  if (reversed || reason) {
    drawNotesBlock(builder, builder.page, {
      title: "Reversal",
      body:
        reason ??
        "This receipt has been reversed and is no longer evidence of a " +
          "collected payment.",
    });
  }

  const notes = str(snapshot["notes"]);
  if (notes) {
    drawNotesBlock(builder, builder.page, { title: "Notes", body: notes });
  }

  drawSectionLabel(builder, "Acknowledgement");
  drawSignatureStrip(builder, [
    ["Received by", str(snapshot["received_by_name"])],
    ["Paid by", str(snapshot["client_name"])],
  ]);

  drawFinalFooter(builder, builder.page, {
    footerNote: reversed
      ? "REVERSED — this receipt does not evidence a collected payment."
      : "Official receipt for a loan repayment. Allocation across principal, " +
        "interest, fees and penalty is determined by the lender's ledger.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

export default generateLoanAgreementPdf;

/* ------------------------------------------------------------------ */
/* lending.client_statement                                            */
/* ------------------------------------------------------------------ */

export async function generateClientStatementPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: LendingRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper("generateClientStatementPdf", options);
  const builder = await startSheet(snapshot, organization, options, "CLIENT STATEMENT");
  const currency = str(snapshot["currency"]);
  const typography = resolveTypography("ledger");

  drawFactsGrid(builder, "Client", [
    ["Client", str(snapshot["client_name"])],
    ["Client number", str(snapshot["client_number"])],
    ["National ID", str(snapshot["client_national_id"])],
    ["Phone", str(snapshot["client_phone"])],
    ["Status", str(snapshot["client_status"])?.toUpperCase() ?? null],
    ["Branch", str(snapshot["branch_name"])],
    ["Loan officer", str(snapshot["officer_name"])],
    ["Issued on", date(snapshot["issue_date"])],
  ]);

  const entries = rows(snapshot, "entries");
  drawSectionLabel(builder, "Account Activity");
  if (entries.length === 0) {
    builder.ensureSpace(20);
    builder.page.drawText("No movements recorded for this client.", {
      x: builder.state.margin,
      y: builder.y,
      size: 8.5,
      font: builder.fontRegular,
      color: theme.color.medGray,
    });
    builder.y -= 18;
  } else {
    drawDataTable(builder, {
      typography,
      currency: currency ?? undefined,
      columns: [
        { key: "date", header: "Date", width: 12, align: "left" },
        { key: "loan_number", header: "Loan", width: 15, align: "left" },
        { key: "description", header: "Description", width: 26, align: "left" },
        { key: "reference", header: "Reference", width: 15, align: "left" },
        { key: "amount_out", header: "Disbursed", width: 16, format: "currency", align: "right" },
        { key: "amount_in", header: "Received", width: 16, format: "currency", align: "right" },
      ],
      rows: entries.map((e) => ({
        date: date(e["date"]) ?? "",
        loan_number: str(e["loan_number"]) ?? "",
        description: str(e["description"]) ?? (humanise(e["entry_type"]) ?? ""),
        reference: str(e["reference"]) ?? "",
        amount_out: num(e["amount_out"]) || "",
        amount_in: num(e["amount_in"]) || "",
      })),
    });
    builder.y -= 8;
  }

  const loans = rows(snapshot, "loans");
  if (loans.length > 0) {
    drawSectionLabel(builder, "Loan Positions");
    drawDataTable(builder, {
      typography,
      currency: currency ?? undefined,
      columns: [
        { key: "loan_number", header: "Loan", width: 20, align: "left" },
        { key: "status", header: "Status", width: 14, align: "left" },
        { key: "principal_outstanding", header: "Principal", width: 17, format: "currency", align: "right" },
        { key: "interest_outstanding", header: "Interest", width: 16, format: "currency", align: "right" },
        { key: "fees_outstanding", header: "Fees", width: 15, format: "currency", align: "right" },
        { key: "total_outstanding", header: "Outstanding", width: 18, format: "currency", align: "right" },
      ],
      rows: loans.map((l) => ({
        loan_number: str(l["loan_number"]) ?? "",
        status: humanise(l["status"]) ?? "",
        principal_outstanding: num(l["principal_outstanding"]),
        interest_outstanding: num(l["interest_outstanding"]),
        fees_outstanding: num(l["fees_outstanding"]),
        total_outstanding: num(l["total_outstanding"]),
      })),
    });
    builder.y -= 8;
  }

  drawSectionLabel(builder, "Position");
  drawFactsGrid(builder, "Total exposure", [
    ["Principal outstanding", money(snapshot["principal_outstanding"], currency)],
    ["Interest outstanding", money(snapshot["interest_outstanding"], currency)],
    ["Fees outstanding", money(snapshot["fees_outstanding"], currency)],
    ["Total outstanding", money(snapshot["total_outstanding"], currency)],
    ["Total collected", money(snapshot["total_collected"], currency)],
  ]);

  drawFinalFooter(builder, builder.page, {
    footerNote:
      "Client statement. Balances and allocations are computed and maintained " +
      "by the lender's ledger as at the date of issue.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

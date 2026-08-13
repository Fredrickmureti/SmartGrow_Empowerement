/**
 * Journal Voucher layout (`finance.journal_entry`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `generateDocumentPdf` draws a priced commercial document: a "Bill To"
 * recipient, a Qty / Unit price / Tax / Line total ladder and a
 * "Balance Due". A journal voucher has none of those things. It has two
 * money columns (debit and credit), an account per line, and a balance
 * control — routing it through the commercial renderer would produce an
 * invoice addressed to nobody with a zeroed totals ladder, the same class
 * of defect that statements and RFQs already have dedicated layouts for.
 *
 * Audience is internal and evidentiary: the reviewer, the approver and the
 * auditor. Every enterprise ledger (SAP, Oracle, NetSuite, Odoo) prints
 * this artefact — so the layout carries what an auditor tests: the
 * posting, the balance control, the source, the reversal linkage, the
 * audit trail and a signature strip.
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

export interface JournalRenderOptions {
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
  if (!Number.isFinite(n)) throw new Error(`journal_numeric_invalid:${String(v)}`);
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

/** "expense" → "Expense", "bank_feed" → "Bank feed". */
function humanise(v: unknown): string | null {
  const s = str(v)?.replace(/_/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/**
 * A voucher is a filed accounting record with an account column, two money
 * columns and a signature strip. None of that survives an 80 mm roll, and
 * an unreadable audit artefact is worse than a refusal.
 */
function assertSheetPaper(options: JournalRenderOptions): void {
  const paper = String(options.paperFormat ?? "").toLowerCase();
  if (paper === "40mm" || paper === "58mm" || paper === "80mm") {
    throw new Error(
      `generateJournalVoucherPdf invoked with thermal paper "${paper}". ` +
        `Journal vouchers are sheet-only by construction.`,
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

/**
 * Signature strip. A voucher is only evidence once someone owns it, so the
 * three accounting roles are always printed — filled from the audit trail
 * where the system knows the actor, blank-ruled where it does not.
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

export async function generateJournalVoucherPdf(
  snapshot: Snapshot,
  organization: OrganizationBranding | null | undefined,
  options: JournalRenderOptions = {},
): Promise<Uint8Array> {
  assertSheetPaper(options);

  const number = str(snapshot["document_number"]) ?? "";
  const status = str(snapshot["status"]);
  const isDraft = snapshot["is_draft"] === true;
  const currency = str(snapshot["currency"]) ?? "";
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
      title: str(snapshot["document_type_label"]) ?? "JOURNAL VOUCHER",
      dateRange: subtitle,
      organization: organization ?? null,
      companyName: str(snapshot["business_name"]) ?? organization?.name,
      logo,
      typography,
    });
    return drawn.bodyY;
  };

  builder.newPage();

  const flags = Array.isArray(snapshot["flags"]) ? (snapshot["flags"] as string[]) : [];
  const rate = snapshot["exchange_rate"];
  const baseCurrency = str(snapshot["base_currency"]);

  drawFactsGrid(builder, "Entry", [
    ["Voucher number", number || null],
    ["Status", status ? status.toUpperCase() : null],
    ["Posting date", date(snapshot["posting_date"] ?? snapshot["issue_date"])],
    ["Reference", str(snapshot["reference"])],
    ["Source", humanise(snapshot["source"]) ?? "Manual"],
    ["Source detail", humanise(snapshot["source_detail"])],
    ["Currency", currency || null],
    [
      "Rate to base",
      rate === null || rate === undefined
        ? null
        : `${num(rate)}${baseCurrency && baseCurrency !== currency ? ` ${currency}/${baseCurrency}` : ""}`,
    ],
    ["Classification", flags.length ? flags.join(", ") : null],
    ["Reversal of", str(snapshot["reversal_of_number"])],
    ["Reversed by", str(snapshot["reversed_by_number"])],
  ]);

  const narration = str(snapshot["description"]);
  if (narration) {
    drawNotesBlock(builder, builder.page, { title: "Narration", body: narration });
  }

  const lines = Array.isArray(snapshot["lines"]) ? (snapshot["lines"] as Snapshot[]) : [];
  const hasTxnCurrency = lines.some((l) => Boolean(str(l["transaction_currency"])));
  const hasAnalytic = lines.some((l) => Boolean(str(l["analytic_account_name"])));
  const hasPartner = lines.some((l) => Boolean(str(l["partner_name"])));

  // Debit/credit are always booked in the ledger's base currency. When the
  // entry was transacted in another currency the transaction columns carry
  // that side, so labelling the money columns with the transaction symbol
  // (the old behaviour: USD 54.17 booked as "$54.17" in a KES ledger) would
  // misstate the entry.
  const ledgerCurrency = baseCurrency ?? currency;
  const moneyHeader = (label: string) =>
    hasTxnCurrency && ledgerCurrency ? `${label} (${ledgerCurrency})` : label;

  const columns = [
    { key: "line", header: "#", width: 3.5, align: "right" as const },
    { key: "account_code", header: "Account", width: 9, align: "left" as const },
    { key: "account_name", header: "Account name", width: hasTxnCurrency ? 20 : 26, align: "left" as const },
    { key: "description", header: "Line narration", width: hasTxnCurrency ? 18 : 24, align: "left" as const },
    ...(hasPartner
      ? [{ key: "partner", header: "Partner", width: 12, align: "left" as const }]
      : []),
    ...(hasAnalytic
      ? [{ key: "analytic", header: "Analytic", width: 11, align: "left" as const }]
      : []),
    ...(hasTxnCurrency
      ? [
          { key: "txn", header: "Txn ccy", width: 7, align: "left" as const },
          { key: "txn_debit", header: "Txn debit", width: 10, format: "number", align: "right" as const },
          { key: "txn_credit", header: "Txn credit", width: 10, format: "number", align: "right" as const },
        ]
      : []),
    { key: "debit", header: moneyHeader("Debit"), width: 13, format: "currency", align: "right" as const },
    { key: "credit", header: moneyHeader("Credit"), width: 13, format: "currency", align: "right" as const },
  ];

  // Debit/credit are printed exactly as booked — an empty side prints as a
  // blank, never as 0.00, so a reader can never misread which side moved.
  drawDataTable(builder, {
    columns,
    currency: ledgerCurrency,
    typography,
    rows: [
      ...lines.map((l, idx) => ({
        line: str(l["line"]) ?? String(idx + 1),
        account_code: str(l["account_code"]) ?? "",
        account_name: str(l["account_name"]) ?? "",
        description: str(l["description"]) ?? "",
        partner: str(l["partner_name"]) ?? "",
        analytic: str(l["analytic_account_name"]) ?? "",
        txn: str(l["transaction_currency"]) ?? "",
        txn_debit: l["transaction_debit"] === null ? "" : num(l["transaction_debit"]) || "",
        txn_credit: l["transaction_credit"] === null ? "" : num(l["transaction_credit"]) || "",
        debit: num(l["debit"]) || "",
        credit: num(l["credit"]) || "",
      })),
      {
        line: "",
        account_code: "",
        account_name: "TOTAL",
        description: "",
        partner: "",
        analytic: "",
        txn: "",
        txn_debit: hasTxnCurrency
          ? lines.reduce((s, l) => s + num(l["transaction_debit"]), 0) || ""
          : "",
        txn_credit: hasTxnCurrency
          ? lines.reduce((s, l) => s + num(l["transaction_credit"]), 0) || ""
          : "",
        debit: num(snapshot["total_debit"]),
        credit: num(snapshot["total_credit"]),
        _isGrandTotal: true,
      },
    ],
  });

  builder.y -= 8;

  // Balance control. Printing it is the whole point of the artefact: a
  // voucher that does not state whether it balanced is not evidence.
  const balanced = snapshot["is_balanced"] === true;
  builder.ensureSpace(20);
  builder.page.drawText(
    balanced
      ? "Balance control: debits equal credits."
      : `Balance control: OUT OF BALANCE by ${(
          num(snapshot["total_debit"]) - num(snapshot["total_credit"])
        ).toFixed(2)} ${currency}.`,
    {
      x: builder.state.margin,
      y: builder.y,
      size: 8.5,
      font: builder.fontBold,
      color: balanced ? theme.color.medGray : theme.color.text,
    },
  );
  builder.y -= 20;

  const reason = str(snapshot["reversal_reason"]) ?? str(snapshot["void_reason"]);
  if (reason) {
    drawNotesBlock(builder, builder.page, { title: "Reason", body: reason });
  }

  const trail = Array.isArray(snapshot["audit_trail"])
    ? (snapshot["audit_trail"] as Snapshot[])
    : [];
  if (trail.length > 0) {
    drawSectionLabel(builder, "Audit Trail");
    drawDataTable(builder, {
      typography,
      columns: [
        { key: "event", header: "Event", width: 24, align: "left" },
        { key: "actor", header: "By", width: 40, align: "left" },
        { key: "at", header: "When", width: 36, align: "left" },
      ],
      rows: trail.map((e) => ({
        event: str(e["event"]) ?? "",
        actor: str(e["actor"]) ?? "—",
        at: dateTime(e["at"]) ?? "",
      })),
    });
    builder.y -= 12;
  }

  const byEvent = new Map<string, string | null>();
  for (const e of trail) byEvent.set(String(e["event"] ?? ""), str(e["actor"]));
  // The heading and the three signature wells are one unit: a page that
  // carries only "Authorisation" reads as a lost page in an audit file.
  builder.ensureSpace(96);
  drawSectionLabel(builder, "Authorisation");
  drawSignatureStrip(builder, [
    ["Prepared by", byEvent.get("Prepared") ?? null],
    ["Reviewed by", byEvent.get("Submitted") ?? null],
    ["Approved by", byEvent.get("Approved") ?? byEvent.get("Posted") ?? null],
  ]);

  drawFinalFooter(builder, builder.page, {
    footerNote: isDraft
      ? "DRAFT — this voucher has not been posted to the general ledger and is " +
        "not evidence of an accounting entry."
      : "Internal accounting voucher. Retained as supporting evidence for the " +
        "general ledger posting identified above.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

export default generateJournalVoucherPdf;
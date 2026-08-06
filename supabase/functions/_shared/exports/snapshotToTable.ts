/**
 * snapshotToTable — the ONE tabular projection of a document snapshot.
 *
 * An export is a *view of the same document*, not a second document. So a
 * CSV or XLSX extract is produced from the identical frozen
 * `document_records.snapshot` that produced the PDF, projected onto a
 * medium-neutral table description. Both serialisers consume this; neither
 * touches the database.
 *
 * Keeping the projection here (rather than in each serialiser) is what
 * guarantees the CSV and the XLSX of one document agree — and, because the
 * snapshot is frozen, that both agree with the printed and emailed PDF.
 */

import type { RenderContext } from "../rendering/types.ts";

export interface TableSection {
  /** Omitted for the leading key/value masthead. */
  headers?: string[];
  rows: Array<Array<string | number | null>>;
  /** Sheet-friendly caption, blank-line separated in CSV. */
  caption?: string;
}

export interface DocumentTable {
  title: string;
  sections: TableSection[];
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Statements are transaction ledgers; every other document is line items. */
function isStatement(kindCode: string, snapshot: Record<string, unknown>): boolean {
  return (
    kindCode.endsWith(".statement") ||
    Array.isArray(snapshot["statement_transactions"])
  );
}

function mastheadRows(
  snapshot: Record<string, unknown>,
  context: RenderContext,
): Array<Array<string | number | null>> {
  const contact = (snapshot["contact"] ?? {}) as Record<string, unknown>;
  return [
    ["Document", str(snapshot["document_number"] ?? context.document.number)],
    ["Type", str(snapshot["document_type_label"] ?? context.document.kind_code)],
    ["Contact", str(contact["name"])],
    ["Date", str(snapshot["issue_date"] ?? context.document.date)],
    ["Currency", str(snapshot["currency"] ?? context.document.currency)],
    ["Status", str(snapshot["status"])],
  ].filter((row) => row[1] !== "");
}

function statementTable(
  snapshot: Record<string, unknown>,
  context: RenderContext,
): DocumentTable {
  const txns = (snapshot["statement_transactions"] ?? []) as Array<
    Record<string, unknown>
  >;
  const aging = (snapshot["statement_aging"] ?? []) as Array<
    Record<string, unknown>
  >;

  const sections: TableSection[] = [
    {
      rows: [
        ...mastheadRows(snapshot, context),
        ["Period start", str(snapshot["statement_period_start"])],
        ["Period end", str(snapshot["statement_period_end"])],
        ["Opening balance", num(snapshot["statement_opening_balance"])],
        [
          "Closing balance",
          num(snapshot["statement_closing_balance"] ?? snapshot["total"]),
        ],
      ],
    },
    {
      caption: "Transactions",
      headers: [
        "Date",
        "Type",
        "Reference",
        "Description",
        "Charges",
        "Credits",
        "Balance",
      ],
      rows: txns.map((t) => [
        str(t["date"]),
        str(t["type"]),
        str(t["reference"]),
        str(t["description"]),
        num(t["charges"]),
        num(t["credits"]),
        num(t["balance"]),
      ]),
    },
  ];

  if (aging.length) {
    sections.push({
      caption: "Aging",
      headers: ["Bucket", "Amount"],
      rows: aging.map((a) => [str(a["label"]), num(a["amount"])]),
    });
  }

  return { title: str(snapshot["document_type_label"] ?? "STATEMENT"), sections };
}

function lineItemTable(
  snapshot: Record<string, unknown>,
  context: RenderContext,
): DocumentTable {
  const items = (snapshot["items"] ?? []) as Array<Record<string, unknown>>;
  // Quantity-only paperwork (GRN, delivery note, warehouse returns) hides
  // money on the printed copy; the extract must hide it too, or the export
  // becomes a side channel around the document's own disclosure rules.
  const hideAmounts = snapshot["hide_amounts"] === true;

  const headers = hideAmounts
    ? ["SKU", "Description", "Quantity", "Unit"]
    : [
        "SKU",
        "Description",
        "Quantity",
        "Unit",
        "Unit price",
        "Discount %",
        "Tax rate",
        "Line total",
      ];

  const rows = items.map((item) => {
    const base = [
      str(item["sku"]),
      str(item["description"]),
      num(item["quantity"]),
      str(item["uom_snapshot"] ?? item["base_uom_label"]),
    ];
    if (hideAmounts) return base;
    return [
      ...base,
      num(item["unit_price"]),
      num(item["discount_percent"]),
      num(item["tax_rate"]),
      num(item["line_total"]),
    ];
  });

  const sections: TableSection[] = [
    { rows: mastheadRows(snapshot, context) },
    { caption: "Line items", headers, rows },
  ];

  if (!hideAmounts) {
    sections.push({
      caption: "Totals",
      headers: ["Label", "Amount"],
      rows: [
        ["Subtotal", num(snapshot["subtotal"])],
        ["Discount", num(snapshot["discount_amount"])],
        ["Tax", num(snapshot["tax_amount"])],
        ["Total", num(snapshot["total"])],
        ["Amount paid", num(snapshot["amount_paid"])],
      ],
    });
  }

  return {
    title: str(snapshot["document_type_label"] ?? context.document.kind_code),
    sections,
  };
}

export function snapshotToTable(context: RenderContext): DocumentTable {
  const snapshot = context.document.snapshot ?? {};
  return isStatement(context.document.kind_code, snapshot)
    ? statementTable(snapshot, context)
    : lineItemTable(snapshot, context);
}

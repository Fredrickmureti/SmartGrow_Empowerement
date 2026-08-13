/**
 * Phase C guardrail — Printing Event Coverage Matrix integrity.
 *
 * The matrix in `docs/printing-event-coverage.md` is the authoritative
 * index of business-event → renderer bindings (ADR-0086). This test
 * keeps three invariants true so the matrix cannot silently drift out
 * of sync with code:
 *
 *   1. **No open GAPs.** Every row in the matrix is `WIRED`. `PARTIAL`
 *      or `GAP` rows must be resolved (or explicitly re-classified as
 *      a follow-up ticket) before the row status is set.
 *
 *   2. **Fetcher ⇔ matrix (A4 path).** Every document type registered
 *      in `FETCHER_MAP` inside `generate-document/index.ts` appears in
 *      the matrix, and every A4 matrix row appears in `FETCHER_MAP`.
 *      Aliases (e.g. `purchase_return` ↔ `vendor_return`) are allowed;
 *      we only require that at least one of the alias names is present
 *      on each side.
 *
 *   3. **The follow-up section carries no un-struck live tickets.**
 *      A ticket text that is not wrapped in `~~…~~` (closed) must be
 *      accompanied by an explicit `Owner:` / `Deferred:` marker so the
 *      matrix isn't used as a graveyard of forgotten items.
 *
 * A single test file is deliberate: matrix integrity is a cross-cutting
 * concern and belongs next to the other ADR guards under
 * `src/test/architecture/`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../");
const MATRIX_PATH = resolve(ROOT, "docs/printing-event-coverage.md");
const EDGE_PATH = resolve(
  ROOT,
  "supabase/functions/generate-document/index.ts",
);

// Document types intentionally NOT surfaced through the A4 FETCHER_MAP.
// Receipts / labels have their own render paths (Line[] AST, LabelDoc).
const RECEIPT_ONLY_TYPES = new Set<string>([
  "pos_receipt",
  "pos_return_receipt",
  "customer_payment_receipt",
  "vendor_payment_receipt",
  "kitchen_ticket",
  "pos_fiscal_report",
  "drawer_slip",
  // `receipt` is the fetcher name for the customer payment receipt
  // (matrix row: `customer_payment_receipt`). Aliases resolve.
  "receipt",
]);


// Types registered in FETCHER_MAP that are not enumerated in the matrix
// on purpose (aliases are handled via ALIASES below).
const FETCHER_EXEMPT = new Set<string>([]);

// Matrix rows whose renderer is NOT the `generate-document` FETCHER_MAP
// path — statutory / payroll documents ship through pinned-paper
// pipelines documented in the payroll wave (payslips, tax certs,
// statutory returns, audit certs). They're listed in the matrix for
// completeness; the fetcher-parity check exempts them.
const MATRIX_ROW_EXEMPT = new Set<string>([
  "payslip",
  "tax_certificate",
  "statutory_return",
  "audit_certificate",
  // Ledger evidence: the journal voucher is frozen into `document_records`
  // and drawn by the `journal_voucher` layout through the rendering engine,
  // so it has no legacy `generate-document` fetcher by design.
  "journal_entry",
]);

// Bi-directional aliases: presence of any name on either side satisfies
// the other. Keep in lock-step with `FETCHER_MAP` comments.
const ALIASES: Record<string, string[]> = {
  goods_receipt: ["goods_received_note", "grn"],
  goods_received_note: ["goods_receipt", "grn"],
  grn: ["goods_receipt", "goods_received_note"],
  vendor_return: ["purchase_return"],
  purchase_return: ["vendor_return"],
  proforma: ["proforma_invoice"],
  proforma_invoice: ["proforma"],
  // `fetchReceipt` renders the customer payment receipt; the matrix
  // labels the receipts-section row `customer_payment_receipt`.
  receipt: ["customer_payment_receipt"],
  customer_payment_receipt: ["receipt"],
};


function anyAliasIn(name: string, set: Set<string>): boolean {
  if (set.has(name)) return true;
  for (const alt of ALIASES[name] ?? []) if (set.has(alt)) return true;
  return false;
}

function parseFetcherMap(src: string): string[] {
  const start = src.indexOf("const FETCHER_MAP");
  expect(start, "FETCHER_MAP must exist").toBeGreaterThan(-1);
  const end = src.indexOf("};", start);
  const block = src.slice(start, end);
  const keys: string[] = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*fetch/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function parseMatrixDocTypes(md: string): {
  a4: string[];
  receipts: string[];
  allStatuses: { row: string; status: string }[];
} {
  const lines = md.split("\n");
  const a4: string[] = [];
  const receipts: string[] = [];
  const allStatuses: { row: string; status: string }[] = [];
  let section: "labels" | "receipts" | "a4" | null = null;

  for (const line of lines) {
    if (/^##\s+Labels\b/i.test(line)) section = "labels";
    else if (/^##\s+Receipts\b/i.test(line)) section = "receipts";
    else if (/^##\s+A4\b/i.test(line)) section = "a4";
    else if (/^##\s/.test(line)) section = null;

    // Table rows only (skip header + separator).
    if (!section) continue;
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*-+/.test(line)) continue;
    if (/business event/i.test(line)) continue;

    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    // Extract the backticked document-type identifier from the row.
    const codeMatch = line.match(/`([a-z_]+)`/);
    const status = cells[cells.length - 1];
    allStatuses.push({ row: line, status });

    if (!codeMatch) continue;
    const key = codeMatch[1];
    if (section === "a4") a4.push(key);
    else if (section === "receipts") receipts.push(key);
  }
  return { a4, receipts, allStatuses };
}

describe("architecture: Printing Event Coverage Matrix integrity (Phase C)", () => {
  const md = readFileSync(MATRIX_PATH, "utf-8");
  const edge = readFileSync(EDGE_PATH, "utf-8");
  const fetchers = parseFetcherMap(edge);
  const matrix = parseMatrixDocTypes(md);

  it("has no PARTIAL or GAP rows in any table (invariant 1)", () => {
    const offenders = matrix.allStatuses.filter((r) =>
      /\b(PARTIAL|GAP)\b/.test(r.status),
    );
    expect(
      offenders,
      `Matrix rows must be WIRED. Offenders:\n${offenders.map((o) => o.row).join("\n")}`,
    ).toHaveLength(0);
  });

  it("every FETCHER_MAP entry (except payroll/statutory exempts) appears in the A4 matrix (invariant 2a)", () => {
    const matrixA4 = new Set(matrix.a4);
    // Also allow presence in the receipts section for hybrid types
    // (e.g. `drawer_slip` is registered in FETCHER_MAP but is a receipt).
    const matrixReceipts = new Set(matrix.receipts);
    const missing = fetchers.filter((f) => {
      if (FETCHER_EXEMPT.has(f)) return false;
      if (RECEIPT_ONLY_TYPES.has(f)) return !anyAliasIn(f, matrixReceipts);
      return !anyAliasIn(f, matrixA4);
    });
    expect(
      missing,
      `Fetchers missing a matrix row: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every A4 matrix row has a matching fetcher (invariant 2b)", () => {
    const fetcherSet = new Set(fetchers);
    const missing = matrix.a4
      .filter((k) => !MATRIX_ROW_EXEMPT.has(k))
      .filter((k) => !anyAliasIn(k, fetcherSet));
    expect(
      missing,
      `A4 matrix rows without a fetcher: ${missing.join(", ")}`,
    ).toEqual([]);
  });


  it("follow-up tickets are all closed (struck) or explicitly owned (invariant 3)", () => {
    const followupIdx = md.indexOf("## Follow-up tickets");
    if (followupIdx === -1) return; // nothing to check
    const section = md.slice(followupIdx);
    // Bullets in the follow-up section: either strikethrough `~~…~~`
    // (resolved) or contain an explicit `Owner:` / `Deferred:` marker.
    const bullets = section.split(/^\s*-\s+/m).slice(1);
    const orphans = bullets.filter((b) => {
      if (/^~~/.test(b.trim())) return false;
      if (/\bOwner:|\bDeferred:/.test(b)) return false;
      return true;
    });
    expect(
      orphans,
      `Open follow-up tickets need an Owner: or Deferred: marker (or strike-through when done):\n${orphans.join("\n---\n")}`,
    ).toEqual([]);
  });
});

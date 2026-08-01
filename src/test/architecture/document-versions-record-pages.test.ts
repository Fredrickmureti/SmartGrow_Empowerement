/**
 * Wave B3.5 — every full record page under Sales / Purchases must mount
 * `DocumentVersionsSection` so record pages and peek sheets show the
 * same immutable artifact history (ADR-0084).
 *
 * A record page that ships without the section would silently regress
 * the audit-trail UX for that document type; this guard catches it in
 * CI, mirroring the peek-sheet expectation set in Wave B3.4.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");
const RECORD_DIRS = [
  resolve(ROOT, "features/sales"),
  resolve(ROOT, "features/purchases"),
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/RecordPage\.tsx$/.test(entry)) acc.push(full);
  }
  return acc;
}

/**
 * Record pages that are NOT rendered artifacts. A version history panel on
 * these would always be empty because no `document_records` row is ever
 * frozen for them — they are master data (contacts) or pre-document
 * workflow objects with no snapshot builder in
 * `src/services/documents/resolveSourceDocumentRecord.ts`.
 *
 * Adding a printable document type for any of these means removing it from
 * this list in the same change.
 */
const NOT_A_RENDERED_DOCUMENT: Record<string, string> = {
  "features/sales/customers/CustomerRecordPage.tsx":
    "master data — statements are their own records and carry the history",
  "features/sales/recurring/RecurringInvoiceRecordPage.tsx":
    "schedule, not an artifact — the generated invoices carry the history",
  "features/purchases/contracts/ContractRecordPage.tsx":
    "no snapshot builder / print coverage for purchase contracts",
  "features/purchases/requisitions/RequisitionRecordPage.tsx":
    "internal pre-PO workflow object, never rendered",
  "features/purchases/rfqs/RFQRecordPage.tsx":
    "no snapshot builder / print coverage for RFQs",
  "features/purchases/suppliers/SupplierRecordPage.tsx":
    "master data — vendor statements carry the history",
};

describe("Wave B3.5 — record pages mount DocumentVersionsSection", () => {
  it("every printable *RecordPage.tsx under Sales/Purchases imports DocumentVersionsSection", () => {
    const pages: string[] = [];
    for (const dir of RECORD_DIRS) walk(dir, pages);
    expect(pages.length, "expected to find at least one RecordPage.tsx").toBeGreaterThan(0);

    const seen = new Set<string>();
    const offenders: string[] = [];
    for (const abs of pages) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      seen.add(rel);
      if (rel in NOT_A_RENDERED_DOCUMENT) continue;
      const text = readFileSync(abs, "utf-8");
      if (!/DocumentVersionsSection/.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Record pages missing DocumentVersionsSection (Wave B3.5 parity):\n${offenders.join("\n")}`,
    ).toEqual([]);

    // The exemption list must not rot: every entry has to point at a page
    // that still exists and still lacks the section.
    const stale = Object.keys(NOT_A_RENDERED_DOCUMENT).filter(
      (rel) => !seen.has(rel) || /DocumentVersionsSection/.test(readFileSync(join(ROOT, rel), "utf-8")),
    );
    expect(stale, `Stale exemptions — remove from NOT_A_RENDERED_DOCUMENT:\n${stale.join("\n")}`).toEqual([]);
  });
});

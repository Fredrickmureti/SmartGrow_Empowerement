/**
 * Journal voucher wiring — locks the ledger-document seam.
 *
 * A journal entry is internal accounting evidence: it must render through
 * the ONE document pipeline (snapshot → document_records → rendering
 * engine → `journal_voucher` layout), carry no email disposition, and
 * expose the same Preview/Print/Download vocabulary on all three surfaces.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("journal voucher wiring", () => {
  it("is registered in the source-document registry with no counterparty", () => {
    const src = read("src/services/documents/resolveSourceDocumentRecord.ts");
    expect(src).toMatch(/journal_entry:\s*\{/);
    expect(src).toContain('kindCode: "finance.journal_entry"');
    expect(src).toMatch(/journal_entry:[\s\S]{0,400}partyKind:\s*null/);
  });

  it("is dispatched to the dedicated ledger layout, not the invoice layout", () => {
    const src = read("supabase/functions/_shared/rendering/renderers/pdf.ts");
    expect(src).toContain("LEDGER_LAYOUTS");
    expect(src).toContain('"finance.journal_entry"');
    expect(src).toContain("generateJournalVoucherPdf");
  });

  it("exposes exactly one action vocabulary shared by all three surfaces", () => {
    const hook = read(
      "src/features/finance/journal-entries/useJournalEntryActions.tsx",
    );
    for (const id of ['id: "preview"', 'id: "print"', 'id: "download"']) {
      expect(hook).toContain(id);
    }
    // No email disposition on ledger evidence.
    expect(hook.toLowerCase()).not.toContain("email");

    const surfaces = [
      "src/features/finance/journal-entries/JournalEntryDetailPage.tsx",
      "src/features/finance/journal-entries/JournalEntryPeekSheet.tsx",
      "src/features/finance/journal-entries/JournalEntryOutputMenuItems.tsx",
    ];
    for (const file of surfaces) {
      expect(read(file)).toContain("useJournalEntryActions");
    }
    expect(read("src/pages/JournalEntries.tsx")).toContain(
      "JournalEntryOutputMenuItems",
    );
  });

  it("prints through PrintService, never a hand-rolled render call", () => {
    const print = read("src/features/finance/record/useRecordPrint.ts");
    expect(print).toContain("ensureDocumentRecord");
    expect(print).toContain("acknowledgeRecordPrint");
    expect(print).not.toMatch(/generate-document|window\.print/);
  });
});

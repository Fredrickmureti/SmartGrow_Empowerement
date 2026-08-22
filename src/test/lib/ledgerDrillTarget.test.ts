import { describe, it, expect } from "vitest";
import { resolveLedgerDrillTarget } from "@/lib/reports/ledgerDrillTarget";

describe("resolveLedgerDrillTarget", () => {
  it("opens the source document when the movement came from one", () => {
    expect(
      resolveLedgerDrillTarget({ source_type: "invoice", source_id: "inv-1", journal_entry_id: "je-1" }),
    ).toEqual({ type: "invoice", id: "inv-1" });
  });

  it("opens the journal entry for a manually keyed entry", () => {
    expect(
      resolveLedgerDrillTarget({ source_type: "manual", source_id: "je-1", journal_entry_id: "je-1" }),
    ).toEqual({ type: "journal_entry", id: "je-1" });
  });

  it("opens the journal entry when there is no source document", () => {
    expect(
      resolveLedgerDrillTarget({ source_type: null, source_id: null, journal_entry_id: "je-2" }),
    ).toEqual({ type: "journal_entry", id: "je-2" });
  });

  it("falls back to the entry when a source type carries no id", () => {
    expect(
      resolveLedgerDrillTarget({ source_type: "invoice", source_id: null, journal_entry_id: "je-3" }),
    ).toEqual({ type: "journal_entry", id: "je-3" });
  });

  it("refuses to guess when nothing identifies the movement", () => {
    expect(resolveLedgerDrillTarget({ source_type: "manual", source_id: null })).toBeNull();
  });
});

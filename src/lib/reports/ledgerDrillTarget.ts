/**
 * ledgerDrillTarget — the one rule for "what does clicking a ledger row open?"
 *
 * Trial Balance, General Ledger and Journal Report all drill into the same
 * accounting object, so they must resolve the target identically. Before this
 * module each screen carried its own variant: General Ledger fell back to a
 * raw `journal_entry_lines` lookup in the browser, Journal Report special-cased
 * `source_type = 'manual'`, and Trial Balance's dialog did neither.
 *
 * Accounting rule encoded here:
 * - A movement caused by a business document (invoice, bill, payment, …) is
 *   best explained by that document — open the source.
 * - A movement with no source document, or a "manual" source, IS the journal
 *   entry — open the entry.
 * - Neither available means there is nothing truthful to show; the caller
 *   should not open a preview at all.
 *
 * `manual` is not a document type: the posting engine stamps it on entries a
 * user keyed directly, so it never resolves to a source document.
 */

export interface LedgerDrillInput {
  source_type?: string | null;
  source_id?: string | null;
  /** Journal entry behind the row — returned by `get_general_ledger` / `get_journal_report`. */
  journal_entry_id?: string | null;
}

export interface LedgerDrillTarget {
  type: string;
  id: string;
}

/** Source types that are not documents and therefore never drill to a document. */
const NON_DOCUMENT_SOURCES = new Set(["manual", "opening_balance", "journal_entry"]);

export function resolveLedgerDrillTarget(row: LedgerDrillInput): LedgerDrillTarget | null {
  const type = row.source_type?.trim() || null;
  const id = row.source_id || null;

  if (type && id && !NON_DOCUMENT_SOURCES.has(type)) {
    return { type, id };
  }
  if (row.journal_entry_id) {
    return { type: "journal_entry", id: row.journal_entry_id };
  }
  return null;
}

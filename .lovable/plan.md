# Journal Voucher — audit findings and completion plan

## What I verified against the repo and the live database

Confirmed present and correct:
- `document_kinds` row `finance.journal_entry` exists in the **live** database
  ("Journal Voucher", finance, internal, a4_portrait, intents view/download/print,
  formats pdf, requires_party false). No duplicate/conflicting row; the older
  `finance.journal` row is the Journal *Report*, a different artifact.
- `document_template_ast` system default v1 exists and is active/default,
  layout `journal_voucher`, media a4_portrait, blocks header/meta/notes/
  ledger table/totals/audit/footer.
- Migration `20260813002504_*.sql` is idempotent and matches the live rows.
- Snapshot builder `src/services/documents/snapshots/financeJournalEntry.ts` exists;
  every column it selects from `journal_entries` actually exists in the live schema.
- PDF layout `supabase/functions/_shared/pdf/layouts/journal.ts` exists
  (401 lines, `generateJournalVoucherPdf`, sheet-paper assertion, branded header on
  every page, facts grid, FX rate vs base currency, reversal linkage, signatures).

Confirmed missing — this is where the chain is actually broken:
1. **Renderer dispatch**: `supabase/functions/_shared/rendering/renderers/pdf.ts`
   contains `STATEMENT_LAYOUTS`, `STATEMENT_KIND_CODES` and `PROCUREMENT_LAYOUTS`
   but **no reference to journal at all**. `generateJournalVoucherPdf` is
   unreachable code today — a request for `finance.journal_entry` would fall
   through to `generateDocumentPdf` and produce an invoice-shaped page.
2. **Source-document registry**: `resolveSourceDocumentRecord.ts` REGISTRY has no
   `journal_entry` key, so preview/download cannot resolve a journal entry.
3. **Client wiring**: there is no `src/features/finance/record/` at all
   (only sales and purchases have `useRecordPrint`/`useRecordDownload`).
   `JournalEntryDetailPage` renders `RecordScaffold` with no `actions` and no
   `onPrint` — which is exactly why Print is greyed out. The peek sheet has no
   output actions, and the list row menu in `src/pages/JournalEntries.tsx` is a
   hand-rolled `DropdownMenuItem` block with view/post/edit only.
4. **Coverage matrix**: `docs/printing-event-coverage.md` has no journal row.

Root cause: the previous agent built the two ends (DB registration + PDF layout)
and none of the three joints that connect them. Nothing needs to be undone; the
work is convergence, not rework.

## What gets built

### 1. Renderer registration (the missing joint)
Register `finance.journal_entry` in `rendering/renderers/pdf.ts` next to
`PROCUREMENT_LAYOUTS`, as a new `LEDGER_LAYOUTS` map (dynamic import of
`../../pdf/layouts/journal.ts`), placed **before** the thermal gate so a stray
print policy can never route a ledger sheet onto an 80 mm roll — same rationale
the procurement layouts already document. Forbid `totals`/party blocks for this
kind the way RFQ already does.

### 2. Registry entry
Add `journal_entry` to `resolveSourceDocumentRecord.ts`:
kindCode `finance.journal_entry`, sourceModule `finance`,
sourceDocType `journal_entry`, `partyKind: null` (correct: a voucher has no
counterparty; matches the requisition precedent), builder = the existing
`fetchAndBuildFinanceJournalEntrySnapshot`. This single entry is what enables
`downloadExport` and the preview provider.

### 3. Finance record hooks + one action vocabulary
- `src/features/finance/record/useRecordPrint.ts` and `useRecordDownload.ts`,
  modelled exactly on the purchases twins (snapshot → `ensureDocumentRecord` →
  `printDocumentIntent('a4_document')` → acknowledge; download via
  `downloadExport`). No journal-specific PDF path, no new service.
- `src/features/finance/journal-entries/useJournalEntryActions.tsx` returning the
  single action array (View, Preview, Download, Print, plus the existing
  edit/post/void verbs), consumed by:
  - `JournalEntryDetailPage` via `RecordScaffold actions`,
  - `JournalEntryPeekSheet`,
  - the list row menu, converted to `DocumentActionsMenu`.
  This satisfies the recorded document-action-parity rule.

### 4. Layout hardening (only what the audit shows is needed)
Review `journal.ts` against a real render before declaring it done:
multi-page continuation with repeated column headers, no clipped final row,
signature strip never overlapping the footer, long account names/descriptions
wrapping, zero-suppressed debit/credit cells, draft/posted/voided/reversed
status treatment, and totals taken verbatim from the snapshot
(`total_debit`/`total_credit` as stored) — the renderer displays, never computes.

### 5. Docs and guards
- Add the A4 row to `docs/printing-event-coverage.md` with status `WIRED`
  (required by the coverage integrity test) only after the runtime path passes.
- Architecture test asserting: journal renders through the one renderer, the kind
  carries no `email` intent, the layout emits no invoice/party blocks, and the
  registry entry exists.

### 6. Verification before reporting done
Render real vouchers through the actual pipeline and inspect the PDFs:
single-line, many-line multi-page, draft, posted, voided, reversal pair,
KES base-currency and a USD→KES foreign-currency entry. Then run the printing
coverage, ADR-0085/0086 architecture tests and the TypeScript check.

## Accounting integrity
Debit, credit, currency, exchange rate, status, reversal linkage and the
prepared/submitted/approved/posted trail all come from `journal_entries` /
`journal_entry_lines` through the frozen snapshot. The PDF performs no
accounting arithmetic and the client derives no amounts; the balance indicator
compares the stored totals rather than re-summing lines as truth.

## No new database work
The kind and template rows are already live and correct, so no migration is
planned. If the runtime trace reveals a genuine gap (e.g. a missing grant on a
lookup used by the snapshot), that will be raised as its own migration.

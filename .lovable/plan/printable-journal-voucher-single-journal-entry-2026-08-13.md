# Printable Journal Voucher (single journal entry)

## What I found (verified, not assumed)

- `JournalEntryDetailPage.tsx` renders `RecordScaffold` **without** an `onPrint`
  prop. `RecordScaffold` disables its Print button whenever `onPrint` is absent
  and shows the tooltip "Print is not available for this record". That is the
  entire reason Print is greyed out — there is no bug, the feature was never built.
- There is no journal entry anywhere in the document pipeline:
  - no `journal_entry` key in `resolveSourceDocumentRecord.ts` REGISTRY,
  - no snapshot builder in `src/services/documents/snapshots/`,
  - no `FETCHER_MAP` entry in `generate-document`,
  - no `document_kinds` row, no `document_template_ast` row.
- The list page and peek sheet have no print/preview action either.
- The correct precedent already exists: `purchases.requisition` — an internal,
  party-less A4 document with its own kind, its own AST, and its own dedicated
  PDF layout (`_shared/pdf/layouts/procurement.ts`) precisely because routing it
  through the invoice layout produced an invoice-shaped page.

A journal entry has the same shape problem, only worse: it has no customer, no
supplier, no quantities, no tax ladder and no "balance due". It is a **journal
voucher** — a dated, balanced debit/credit sheet with an audit block. Every
enterprise system (SAP, Oracle, NetSuite, Odoo, QuickBooks, Xero) prints one.

## What gets built

### 1. New document kind: `finance.journal_entry` (migration)
Following the requisition migration exactly:
- `document_kinds` row: label "Journal Voucher", domain `finance`, legal_class
  `internal`, media `a4_portrait`, `requires_party = false`,
  intents `view / download / print` — **no `email` intent** (a journal voucher is
  an internal accounting artefact, not correspondence).
- `document_template_ast` system default v1, layout `journal_voucher`, blocks:
  branded header → meta (number, date, period, journal book, status, source,
  reference, currency) → narration → debit/credit table → totals (debit,
  credit, balanced) → audit trail (prepared / submitted / approved / posted /
  reversed, with reversal linkage) → internal footer.

### 2. Snapshot builder `src/services/documents/snapshots/financeJournalEntry.ts`
Freezes the entry exactly as posted: header, fiscal period, journal book,
reversal linkage (`reversal_of_id` / `reversed_by_id`), and per-line
account code + name, description, analytic account, partner, tax tag,
debit/credit, plus the foreign-currency columns the table actually has
(`original_currency`, `original_debit`, `original_credit`, `exchange_rate`)
so a multi-currency entry prints both the transaction and base amounts.

### 3. Dedicated PDF layout `_shared/pdf/layouts/journal.ts`
`generateJournalVoucherPdf(snapshot, organization, options)`, registered in
`renderers/pdf.ts` beside the procurement layouts (before the thermal gate, so
a stray print policy cannot push a ledger sheet onto an 80 mm roll).

Professional layout, following the report typography `document` profile:
- Branded header with company legal name/address, the words **JOURNAL VOUCHER**,
  voucher number and a DRAFT / POSTED / REVERSED / VOIDED status stamp
  (draft entries print with an unmistakable "DRAFT — NOT POSTED" watermark).
- Two-column meta grid: entry date, posting period, journal book, source
  document, reference, currency + rate, adjusting/closing/opening flags.
- Narration block (description).
- The ledger table: Account code | Account name | Description | Partner |
  Analytic | Debit | Credit — right-aligned, zero-suppressed (blank, not 0.00),
  column-total ruled line, repeating header on page break.
- Totals ladder: total debit, total credit, and an explicit balanced check.
- Audit block: prepared by / date, approved by / date, posted by / date,
  reversal reference — plus signature lines (Prepared / Reviewed / Approved),
  which is what auditors expect on a manual voucher.
- Footer: page x of y, printed-at timestamp, and a reprint marker.

### 4. Client wiring (one path, no shortcuts)
- Register `journal_entry` in `resolveSourceDocumentRecord.ts` (kindCode
  `finance.journal_entry`, module `finance`, `partyKind: null`).
- New `src/features/finance/record/useRecordPrint.ts` twin of the sales/purchases
  hooks (build snapshot → `ensureDocumentRecord` → `printDocumentIntent`
  `a4_document` → acknowledge).
- Add **Preview / Print / Download** to the journal entry detail page,
  peek sheet and list row menu from a single shared `useJournalEntryActions`
  array, so the three surfaces cannot drift (matches the documented
  document-action-parity rule).

### 5. Docs + guards
- Add the A4 row to `docs/printing-event-coverage.md` (status `WIRED`) — the
  coverage integrity test requires it.
- Architecture test: the journal voucher renders through the ONE renderer, the
  kind carries no `email` intent, the layout never emits invoice blocks
  (`totals` money ladder / party billTo), and a draft prints with the draft mark.

## Notes / decisions
- Draft entries **are** printable, stamped DRAFT. Blocking them would break the
  common review-before-posting workflow; masking the state would be worse.
- Reprints replay the frozen snapshot, so a voucher printed after a later
  reversal still shows what was posted at the time, with the reversal reference
  in the audit block.

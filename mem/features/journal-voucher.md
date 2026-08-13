---
name: Journal Voucher (finance.journal_entry)
description: Journal entries print as an internal journal voucher through the canonical snapshot/document-record pipeline; no email intent, no counterparty
type: feature
---

A journal entry's printable form is a **journal voucher** — internal
accounting evidence, not commercial paper.

- Kind `finance.journal_entry` (A4 portrait, intents view/download/print;
  **never** email). No counterparty → `partyKind: null`.
- Pipeline: `fetchAndBuildFinanceJournalEntrySnapshot` → `ensureDocumentRecord`
  → rendering engine → `journal_voucher` layout
  (`supabase/functions/_shared/pdf/layouts/journal.ts`), dispatched via
  `LEDGER_LAYOUTS` in `renderers/pdf.ts` before the thermal gate so a ledger
  sheet can never route to an 80 mm roll.
- One action vocabulary: `useJournalEntryActions` (Preview / Print / Download)
  rendered by the detail page, the peek sheet and the list row menu
  (`JournalEntryOutputMenuItems`). Same parity rule as purchases documents.
- Draft entries are printable and stamped DRAFT — review-before-posting is
  the normal workflow. Reprints replay the frozen snapshot.
- Guard: `src/test/printing/journal-voucher-wiring.test.ts`.

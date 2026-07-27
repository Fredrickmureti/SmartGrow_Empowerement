# ADR 0100 — Hardware Operator Workspace

Status: Accepted (2026-07-27)

## Context

Wave 9 introduced `/platform/hardware/print-queue` and `/platform/hardware/diagnostics`.
They exposed valuable operational data but presented it as raw database
rows: UUIDs, correlation ids, internal enums (`receipt_printer`,
`legal_recipient_statement`, `pdf-browser`), and one endlessly scrolling
list of recent commands. Operators (cashiers, HR officers, warehouse
leads) had no way to answer "was my document printed?" without asking a
developer.

## Decision

The Hardware Operations Workspace is an **operator-first** surface:

1. **Business identity in the primary table.** Every table row shows
   the document number, requester name, printer name, human status, and
   duration. Raw enum keys and UUIDs are forbidden as leaf text in the
   primary tables.
2. **Progressive disclosure via a row drawer.** Correlation ids,
   hardware command ids, raw errors, and full timelines live in
   `JobDetailDrawer.tsx` — one click, still one page.
3. **Presentation contract in `src/apps/platform/hardware/lib/humanize.ts`.**
   All operator-facing text goes through the pure helpers there
   (`docTypeLabel`, `intentLabel`, `formatLabel`, `transportLabel`,
   `statusLabel`, `runtimeReasonLabel`, `classifyError`). New enum
   values must be added here in the same PR that introduces them.
4. **Batched business-identity resolvers.**
   `useDocumentDisplay` / `useRequesterDisplay` / `usePrinterDisplay`
   are the only sanctioned way to turn `(doc_type, doc_id)`,
   `requested_by`, and `device_assignment_id` into human labels. They
   batch per doc_type and cache 60 s via react-query.
5. **Diagnostics is a tabbed workspace**, not a scroll:
   Overview · Devices & health · Activity · Errors & DLQ · Runtime · Support.
   The active tab is URL-synced via `?tab=`.
6. **Support-engineer utilities live under the Support tab.** The
   "Copy diagnostics JSON" button and any future support-bundle
   downloads are moved off the page header.
7. **Server-side pagination + faceted filters + KPI strip** replace the
   old 500-row cap.

## Consequences

- Adding a new print `doc_type` requires two edits: the caller and
  `humanize.ts` (`docTypeLabel`). The architecture guard
  `hardware-operator-workspace-humanized.test.ts` fails if the primary
  tables render raw enums as leaf text.
- The Diagnostics page never grows a new top-level card; new signals
  slot into an existing tab.
- Support engineers still have access to every raw field via the row
  drawer and the "Support engineer view" toggle.
- No schema change, no new RPC, no new edge function.

## References

- `src/apps/platform/hardware/HardwarePrintQueue.tsx`
- `src/apps/platform/hardware/HardwareDiagnostics.tsx`
- `src/apps/platform/hardware/lib/humanize.ts`
- `src/apps/platform/hardware/hooks/useHardwareDisplay.ts`
- `src/apps/platform/hardware/components/JobDetailDrawer.tsx`
- `src/test/architecture/hardware-operator-workspace-humanized.test.ts`
- ADR 0037 (hardware execution topology), ADR 0099 (single registration surface).
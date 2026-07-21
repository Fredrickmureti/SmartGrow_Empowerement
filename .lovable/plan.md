# Printing Architecture — Verification & Continuation Plan

Living hand-off doc. Update at the end of every session.

## Execution Status (2026-07-21, session 3)

### ✅ DONE and verified

| Phase | Deliverable | Verification |
|---|---|---|
| A | Matrix ↔ code reconciliation (only two GAPs were ever open) | Manual read of every `WIRED` row against dispatchers |
| B2 | GRN → A4 auto-dispatch from `GoodsReceiptWizardPage` | Row `goods_receipt` flipped to WIRED; policy resolved by ADR-0088 |
| B1 | Cash-drawer audit slip auto-print on every `pos_cash_movements` insert | `src/test/printing/drawer-slip-wiring.test.ts` (7 tests, green) |
| C.1 | Coverage-matrix integrity arch test | `src/test/architecture/printing-coverage-matrix-integrity.test.ts` (4 tests, green) |
| C.2 | "No page invokes generate-document directly" arch test | `src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts` (pre-existing) |
| C.3 | ESLint `no-raw-*` rules pinned at `error` | `eslint.config.js:134,268,269,288,302` (verified) |
| C.4 | Runbook for adding a new printable artifact | `docs/printing-add-new-artifact.md` |
| — | Matrix hygiene: `vendor_statement` row added; stale `grn` PARTIAL row promoted to WIRED | `docs/printing-event-coverage.md` |

### 🔜 ACTIVE PHASE — Phase D (next agent starts here)

Phase C is functionally complete. Phase D is the first wave of the
**Enterprise Output Platform** roadmap that has NOT yet been touched.
The order below is the enterprise-grade progression; do not reorder.

**Phase D — Delivery observability & re-dispatch (SLA layer)**

Enterprise printing systems (SAP Output Management, Oracle BI Publisher
Delivery, NCR Aloha Print Controller) all treat "print dispatched" as
distinct from "print delivered". Right now the ERP fires
`printClient.print(...)` and forgets. Phase D closes that gap.

Concrete milestones (each is a shippable PR):

1. **D1 — Print job ledger.** Migration for `print_jobs` (id, doc_type,
   doc_id, printer_profile_id, media_profile_id, intent, requested_by,
   requested_at, status enum `queued|sent|acked|failed|abandoned`,
   attempt_count, last_error, correlation_id). GRANTs. RLS scoped to
   business. Insert on every `PrintClient.print(...)`. Row in matrix →
   already exempt (infra table, not a document type).
2. **D2 — Ack loop.** Hardware bridge (`hardware_command_queue`) writes
   `acked_at` back into `print_jobs`. Retry policy: exponential backoff
   3 attempts, then `failed` + toast + audit_log entry. Test: simulate
   an offline printer and assert three retries + `failed`.
3. **D3 — Re-dispatch UI.** "Print queue" page under Settings →
   Printing showing last 200 jobs per branch, filter by status, one-
   click resend (respects idempotency via `correlation_id`).
4. **D4 — SLO alert.** Nightly job flags any `queued > 15min` or
   `failed_rate > 5%` per printer_profile into `security_alerts`.

Do NOT skip D1 to build D3 — the ledger is the load-bearing wall.

### 📌 Deferred (documented, waiting on product input, do NOT start blind)

- **Drawer no-sale slip on `pos_drawer_events`.** The RPC that writes
  those rows doesn't exist yet. Cash-movement slips (Phase B1) cover
  the SOX/PCI evidence trail today. Only start once product confirms
  the manual-open UX and picks between `on_open | on_close | on_both`.
- **Statutory documents in the matrix.** Rows are listed for
  completeness but exempt from the fetcher-parity check
  (`MATRIX_ROW_EXEMPT`). Their ownership lives in the payroll wave.
  Do NOT try to fold them into `FETCHER_MAP` — they are pinned-paper
  and use dedicated edge functions.

## Instructions for the next agent

**Before writing any code**, do this verification pass:

1. Run the full printing-arch test suite:
   ```
   bunx vitest run src/test/architecture/printing-coverage-matrix-integrity.test.ts \
                   src/test/architecture/adr-0085-rendering-ownership.test.ts \
                   src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts \
                   src/test/printing/
   ```
   All must be green. If any are red, fix them **before** starting Phase D.
2. Read `docs/printing-event-coverage.md` top-to-bottom and confirm no
   `PARTIAL`/`GAP` rows (the integrity test enforces this, but eyeball
   check catches semantic drift the parser cannot).
3. Skim `docs/printing-add-new-artifact.md` — if it feels wrong or
   incomplete, patch it in the same PR that consumes it. It is the
   contract for every future contributor.
4. Read `src/services/printing/PrintClient.ts` end-to-end. It is the
   ONLY entry point for print dispatch. Phase D bolts observability
   around it; you should not need to change its public surface.

**Then start Phase D at milestone D1** (print job ledger migration).
Do not jump to D3 (UI) before D1+D2 exist — an empty queue table
would ship dead UI.

**Non-goals for the next session** (documented so you don't get pulled
sideways):
- No new rendering engines. No new template engines.
- No changes to `mediaGeometry.ts` unless a physical device forces it.
- No touching the payroll / statutory paper path from the printing
  layer — that ownership lives in the payroll wave.
- No re-opening B1's `pos_drawer_events` question without product sign-off.

## Reference — canonical files

- Entry point: `src/services/printing/PrintClient.ts`
- Hook wrapper: `src/hooks/usePrintOrPreview.ts`
- Edge fetcher registry: `supabase/functions/generate-document/index.ts` (`FETCHER_MAP`)
- ESC/POS builders: `supabase/functions/_shared/escpos/*` (drawer, kitchen, receipt, …)
- PDF builder: `supabase/functions/_shared/pdf`
- Label compiler: `src/services/printing/labelCompiler.ts` + `labelDispatch.ts`
- Media geometry (single owner): `src/services/printing/mediaGeometry.ts`
- Coverage matrix: `docs/printing-event-coverage.md`
- Runbook: `docs/printing-add-new-artifact.md`
- ADRs: `docs/adr/ADR-0084` … `ADR-0090`

## Definition of done for Phase D

1. `print_jobs` ledger exists and every `PrintClient.print(...)`
   inserts a row (verified by an arch test parsing `PrintClient.ts`).
2. Hardware bridge writes `acked_at`; retry policy tested.
3. Print-queue UI lists + resends jobs; respects RLS.
4. Nightly SLO job flags stalled queues into `security_alerts`.
5. All existing printing tests still green; new tests added per
   milestone.

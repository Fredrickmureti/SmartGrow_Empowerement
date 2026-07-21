# Printing Architecture — Verification & Continuation Plan

Ownership hand-off from the previous engineer.

## Execution Status (2026-07-21, session 2)

**Phase A (reconciliation) — DONE.** Spot-checked every `WIRED` row in
`docs/printing-event-coverage.md` against the codebase (dispatch call
sites for labels, `usePrintOrPreview` / `generate-document` fetchers for
A4, `documentToReceiptLines` for POS receipts). The stale "six GAPs"
claim in the previous session was wrong — only two GAPs were ever open,
and they are the two rows called out in the matrix's follow-up section.

**Phase B2 (GRN → A4 binding) — DONE this turn.**
`GoodsReceiptWizardPage.tsx` now dispatches
`printOrPreview({ documentType: 'goods_receipt', intent: 'a4_document', branchId })`
after a successful post. Routing is delegated to
`print_policies_resolve` (ADR-0088) so branches with a configured policy
auto-print and unconfigured branches fall back to the preview dialog.
Matrix updated; failure is non-blocking so navigation still fires.

**Phase B1 (drawer-slip auto policy) — DEFERRED, needs product input.**
The POS cash-drawer *kick* policy is fully implemented
(`useDrawerPolicy`, stage-L tests). The remaining GAP is a separate
*audit-slip* receipt on `drawer:opened`/`drawer:closed`. There is no
domain-event emission for those transitions yet — designing that is a
product decision (per-terminal opt-out, idempotency key on the saga,
where in the SaleSaga the event fires). Called out as its own ticket so
the guardrail work in Phase C isn't blocked on it.

**Phase C (guardrails) — NOT STARTED.** Will land after B1 has an
owner; adding a "no unWIRED rows in the matrix" test today would
false-fail on the drawer-slip row.



## What we already have (confirmed by direct reads)

Canonical architecture is in place and documented by ADRs 0084 → 0090:

- **Rendering ownership (ADR-0085)** — PDFs via `supabase/functions/_shared/pdf`,
  ESC/POS via `_shared/escpos`, ZPL/EPL via `src/services/printing` + label
  drivers, on-screen barcodes SVG-only. Enforced by ESLint rules
  (`no-raw-pdf-lib-in-app`, `no-direct-barcode-lib`,
  `no-raw-zpl-outside-printing`, `no-raw-escpos-bytes`).
- **Media / printer split (ADR-0087, ADR-0088)** — `media_profiles`,
  `printer_profiles`, `label_templates.body_json` + `mediaGeometry.ts` as
  the single mm→dot owner. Guardrail: `media-geometry-single-owner.test.ts`.
- **Line[] AST for receipts (ADR-0084)** — one row producer feeds both
  ESC/POS bytes and PDF; parity locked by `parity_gate_test.ts`.
- **Visual label designer + LabelDoc compiler (ADR-0090)** — three-pane
  editor writes `body_json`; dispatcher prefers compiled body; guardrails
  `label-coverage.test.ts`, `label-barcode-policy.test.ts`,
  `label-compiler.test.ts`.
- **Scanner as platform service** — `src/services/scanner/` barrel with
  POS/Warehouse/Sales/Inventory consumers.
- **Event coverage matrix** — `docs/printing-event-coverage.md` maps every
  business event to template + renderer + status.

## Phase A — Reconcile the two conflicting status reports (read-only, ~1 h)

`.lovable/plan.md` claims **six wired-status GAPs** remain. The matrix
in `docs/printing-event-coverage.md` lists **only two** open GAPs
(drawer-slip auto policy, GRN policy binding) and every other row is
marked `WIRED`. Before writing code we settle which is right.

1. Re-read the matrix top-to-bottom, then for every `WIRED` row grep the
   codebase for the `template_key` / fetcher and confirm a dispatch call
   site actually exists (not just a seed row).
2. Cross-check against `label-coverage.test.ts` and `printing/*.test.ts`.
3. Produce a single reconciled GAP list — one row per genuinely unwired
   event, appended to the matrix. Delete the stale "six GAPs" wording
   from `.lovable/plan.md`.

Exit: matrix and plan agree; every open item has an owner file and a
failing test we can commit against.

## Phase B — Close the confirmed GAPs

### B1. Drawer-slip auto-print policy (POS cash-drawer saga)

- Add `drawer_event_printed` idempotency key on the POS saga so retries
  don't double-print.
- New `pos_settings.drawer_slip_policy` enum: `off | on_open | on_close | on_both`.
- Saga subscribes to `drawer:opened` / `drawer:closed` domain events and
  dispatches through `PrintClient.print(...)` (never touches ESC/POS bytes
  directly — ADR-0085).
- Per-terminal opt-out for tenants pairing receipt+drawer on the same
  printer.
- Test: saga test that fires the event twice, asserts one print + one
  idempotency-skip.

### B2. GRN → A4 binding (Receiving policy engine, ADR-0088)

- Bind `grn_posted` domain event to `PrintClient.print({ documentType:
  'grn' })` via the receiving policy engine.
- Respect per-warehouse policy (auto / manual / off) stored in
  `warehouse_settings`.
- Flip matrix row from GAP → WIRED in the same PR.

### B3. Any additional GAPs surfaced by Phase A

Each becomes its own small PR: seed row + dispatch call site +
architecture test. No code path new to the platform — reuse the seams
already shipped.

## Phase C — Guardrails to prevent regression (only after B is green)

Deliberately deferred until GAPs close (guardrails against still-open
gaps create false confidence).

- Architecture test: every enum value in `PrintableDocumentType` has a
  row in `printing-event-coverage.md` marked `WIRED`, or is explicitly
  exempted with a reason.
- Architecture test: no route/page imports `generate-document` directly;
  everything goes through `PrintClient.print(...)`.
- ESLint tightening: promote existing `no-raw-*` rules from `warn` to
  `error` in CI (verify current level first — some may already be
  `error`).
- Doc: add "How to add a new printable artifact" runbook under
  `docs/printing-pipeline.md` referencing ADR-0085/86/87/88/90.

## What we are explicitly NOT doing

- **No new rendering engines.** Line[] AST (receipts), LabelDoc
  (labels), PdfBuilder (A4) are the three canonical renderers. Adding a
  fourth would be architectural drift.
- **No template edits to change label sizing.** Media geometry is a
  configuration concern — handled by `media_profiles` + `mediaGeometry.ts`,
  not by touching template bodies.
- **No POS-only assumptions for scanning.** `src/services/scanner/` stays
  the platform service; consumers subscribe, they do not re-implement.
- **No new client-side pdf-lib / bwip-js usage.** Blocked by ESLint;
  don't add exemptions.

## Technical details

- **Files touched in Phase B1:** `src/services/pos/cashDrawerSaga.ts` (or
  equivalent), `supabase/migrations/*_pos_settings_drawer_policy.sql`,
  new test under `src/test/pos/`.
- **Files touched in Phase B2:** receiving policy engine module, new
  migration for `warehouse_settings.grn_print_policy`, dispatch call
  site in the GRN posting handler, test under `src/test/warehouse/`.
- **Migration rule reminder:** every new `public.*` table/column change
  ships with matching `GRANT` statements in the same migration.
- **Server-fn rule reminder:** any new server function reading env vars
  reads them inside `.handler()`, not at module scope; anything that
  needs `requireSupabaseAuth` never runs from a public route loader.

## Definition of done

1. Phase A produces a single authoritative GAP list; matrix and plan.md
   agree.
2. Every remaining GAP is closed with (a) code, (b) a seed, and (c) a
   test that fails without the fix.
3. Phase C guardrails green in CI.
4. `docs/printing-event-coverage.md` shows zero `GAP` / `PARTIAL` rows
   (or each remaining row has an explicit exemption reason).
5. No new rendering engine, no new template engine, no new hardcoded
   dimension anywhere in `src/**` outside `mediaGeometry.ts`.

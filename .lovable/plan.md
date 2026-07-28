
# Enterprise Printing Consolidation — Verified Plan

## Ground truth from the audit (not assumption)

The codebase already routes every printable surface through `src/services/printing/PrintService.ts` and one hardware seam (`dispatch.toDevice → execForIntent → hardwareClient → local-agent per-endpoint FIFO`). What actually exists is **two entry surfaces on the same pipeline**, not two architectures:

- **Direct byte path** — `printDocument` / `printLabel`. Used by POS receipts and inventory/shelf labels. Renders → opens `print_jobs` row → dispatches synchronously → marks acked. Sequential per copy. This is the "reference" behaviour the user cited.
- **Document-intent path** — `printDocumentIntent`. Used by Sales (invoices, estimates, sales orders, proforma, delivery notes, credit notes, returns, customer statements, customer payments), Purchases (GRN, vendor statements), HR letters. Snapshots the source row → `document_records` → `submit-document-intent` edge fn creates one `print_jobs` row per resolved target (print/email/archive) → foreground-drains each print target through `dispatchQueuedJob`, which calls the **same** `toDevice` / `toPage` as the direct path.

Both surfaces converge at `dispatch.ts`. The `dispatch-print-jobs` cron is recovery-only for rows a foreground session opened but never drained.

The user's observation — "Sales wasn't printing, only POS/labels worked" — is a behavioural failure inside the intent surface, not proof of a second architecture. Ripping `printDocumentIntent` out would delete `document_records` snapshotting (immutable reprints for audits, HR tribunals, statements), the policy-driven print/email/archive fanout, and the ledger the intent path opens — regressing enterprise behaviour instead of consolidating it.

## What consolidation actually means here

One pipeline, one hardware seam, two documented entry surfaces chosen by artifact kind:

```text
                    ┌─ printLabel  (labels)          ┐
Business event ─────┤                                 ├──► render ──► print_jobs ledger ──► dispatch ──► execForIntent ──► hardwareClient ──► agent FIFO ──► printer
                    ├─ printDocument (POS receipt)   │
                    └─ printDocumentIntent (docs) ───┘   ▲
                                                          └── policy + document_records snapshot for auditable docs
```

The plan below (1) proves Sales failure is in the intent surface and fixes it, (2) removes real duplicates with evidence, (3) locks the invariant with guardrails so a third surface cannot re-appear.

## Phase 1 — Diagnose the Sales failure (evidence before deletion)

1. Reproduce Sales invoice print in the preview via Playwright, capture console + network for `/submit-document-intent`, `/render-document`, `/generate-document`, `/dispatch-print-jobs`, and any `hardwareClient` calls.
2. Query `print_jobs`, `document_records`, `document_artifacts` for the reproduced click: was a row opened? did it reach `sent`/`acked`, or stay `queued`? which target/transport?
3. Read edge logs for `submit-document-intent` and `dispatch-print-jobs` for the failing rows.
4. Classify the root cause into exactly one bucket and fix in place:
   - **Policy** — no `document_print_policies` target for the doc kind → seed defaults so `submit_document_intent` returns a print target.
   - **Snapshot** — `ensureDocumentRecord` / snapshot builder throws → fix the builder; do not swallow.
   - **Foreground drain** — `dispatchQueuedJob` returns error / transport mismatch / no device bound for PDF page transport in browser → return a typed `needsDevice` or surface the browser print dialog correctly.
   - **Ledger** — `openJob` insert blocked by RLS/grants → repair grants/policies via migration.
5. Verify: repeat the Playwright print, confirm one `print_jobs` row transitions `queued → sent → acked` in a single foreground call, no sweeper involvement.

## Phase 2 — Full entry-point sweep (audit, then delete)

Enumerate every print entry across `src/**`, `supabase/functions/**`, `electron/**`, `agent/**`. For each caller, record: `{file, surface, entry function, hardware seam reached}`. Legitimate entries are exactly `printDocument`, `printLabel`, `printDocumentIntent`, `dispatchPosReceipt` (POS-specific wrapper of `printDocument`), and the module dispatch wrappers (`dispatchHrLetter`, `dispatchGoodsReceipt`, `dispatchVendorStatement`) that all call `printDocumentIntent`.

Anything else — legacy `print-service` shims, `usePrintOrPreview`, direct `generate-document` fetches from pages, ad-hoc `window.print()` shadows, hand-rolled ESC/POS or ZPL, direct `hardwareClient.printRawBytes` outside `src/services/printing/**` — is deleted, and its callers rewritten onto the correct entry surface. Existing ESLint rules (`no-printservice-shim`, `no-raw-escpos-bytes`, `no-raw-zpl-outside-printing`, `no-raw-pdf-lib-in-app`, `no-direct-generate-document-in-pages`, `no-direct-window-print`, `no-document-print-shadow-path`) already forbid this at lint time; extend them where the sweep finds a gap they don't cover.

Deletion is gated on zero remaining callers after rewrites. Every deletion carries a one-line note: file → replacement entry surface.

## Phase 3 — Spool demotion (verify, don't rewrite)

Confirm `dispatch-print-jobs` only claims rows whose `claimed_at is null` AND whose age exceeds the foreground TTL, so a live session's job cannot be stolen. If foreground reliably drains, no code change is needed here. If not, tighten the sweeper's claim predicate and add a `print_jobs_source` column (`foreground`/`recovery`) for observability.

## Phase 4 — Lock the invariant

- Extend `src/test/architecture/printing-architecture.test.ts` to assert: every `pages/**`, `features/**`, `hooks/**`, `apps/**` file that touches printing imports **only** from the sanctioned entry surfaces (allow-list of module paths).
- Extend `src/test/printing/label-coverage.test.ts`-style guardrails to cover every document surface (Sales, Purchases, HR) so a new caller wired to a legacy path fails CI.
- Add a runtime assertion in `dispatch.toDevice` that logs `printing.seam.hit` with `{surface, entry, intent}` so we can observe in production that no second seam is being used.

## Phase 5 — UX consistency

For every module: same "printed / sent to <device> / failed — bind a printer" toast copy, same `needsDevice` CTA to Platform → Hardware, same reprint affordance backed by `document_records`. No technical identifiers in the primary flow; expose `print_jobs.id` and correlation id only in the diagnostics drawer.

## Definition of done

- Sales invoice, estimate, sales order, delivery note, credit note, proforma, return, customer statement, customer payment, vendor statement, GRN, HR letter, POS receipt, product/shelf/lot/bin/pallet/shipping label — all print end-to-end via one of the four sanctioned entry surfaces, with a `print_jobs` row transitioning `queued → sent → acked` in the foreground call.
- Every legacy shim identified in the sweep is deleted; guardrail tests prevent regression.
- `dispatch-print-jobs` runs only against orphaned rows.
- Rapid consecutive prints on Sales invoices land in click order (same FIFO the label lane already has), verified in preview.

## Out of scope for this pass

- Redesigning `document_records` / policy schema.
- New physical media (thermal invoices, mobile PDF share sheet).
- Migrating remaining Supabase edge functions to TanStack server functions — tracked separately; today they are called from the same seam and don't constitute a competing architecture.

## Explicitly rejected shortcuts

- Deleting `printDocumentIntent` and pointing Sales at `printDocument`. That destroys snapshotting, policy fanout, and archive — the exact enterprise properties this consolidation is meant to protect. The two entry surfaces are one architecture; the fix is to make the intent surface reliable, not to remove it.

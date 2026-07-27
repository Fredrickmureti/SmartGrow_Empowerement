# Document, Printing & Hardware Architecture — Project Plan

**Authoritative status document.** Update this file at the end of every phase.
Chronological execution only — do not jump waves. Each wave lands in a
production-ready state before the next begins.

---

## Roadmap at a glance

| Wave | Title | Status |
|---|---|---|
| 1 | Document Domain model (`document_kinds`, `document_records`, `document_artifacts`) | ✅ Complete |
| 2 | Template Registry (`document_templates`, `document_template_ast`) | ✅ Complete |
| 3 | Server-side Rendering Engine (`_shared/rendering/*` + `render-document` fn) | ✅ Complete |
| 4 | Output Intent Resolver (`output_intents`, `resolve-output-intent` fn) | ✅ Complete |
| 5 | Submit-intent chokepoint (`submit-document-intent` fn + `submitIntent` client shim) | ✅ Complete |
| 6 | Hardware Role Aliases + Dispatch Worker (`printer_roles`, `dispatch-print-jobs`, cron, Requeue UI, `/platform/hardware/roles`) | ✅ Complete (deploy-blocked — see below) |
| **6.5** | **Legacy Consolidation Pass** (deduplicate print/email/receipt shadow paths) | **▶ ACTIVE** |
| 7 | POS Receipt Convergence (delete `PrintClient` / `useDocumentPrint` / `ReceiptTemplateGenerator`) | ⏸ Pending 6.5 |
| 8 | Hardware Adapter Internals (BrowserHardwareAdapter cleanup, WebUSB/Electron parity) | ⏸ Pending |
| 9 | Legacy Table & Function Deletion (`document_templates` v1 shim, `receipt_settings`, orphan edge fns) | ⏸ Pending |

---

## ✅ Verified complete (Waves 1–6)

### Wave 1 — Document Domain
- Tables: `document_kinds`, `document_records`, `document_artifacts` with RLS + grants.
- `document_records` is the single business-fact anchor; every downstream artifact FKs to it.

### Wave 2 — Template Registry
- Tables: `document_templates`, `document_template_ast`, `document_theme`, `document_header_footer`.
- `format_registry` + `document_kinds.default_template_id` decouple business kind from render surface.

### Wave 3 — Rendering Engine
- `supabase/functions/_shared/rendering/{engine.ts,renderers/*}` — pure functions, no DB writes.
- Registered renderers: `a4-pdf`, `thermal-receipt` (scaffold), `zpl-label`, `escpos-bytes`.
- `render-document` edge function is the ONLY consumer; hits `document_artifacts` for storage.

### Wave 4 — Output Intent Resolver
- Tables: `output_intents`, `output_dispatch_log`.
- `resolve-output-intent` edge fn returns the routing plan (media × dispositions × copies) per `document_record`.

### Wave 5 — Submit-intent chokepoint
- `submit-document-intent` edge fn: resolves plan → inserts one `print_jobs` row per target.
- Client shim: `src/services/documents/submitIntent.ts` (sole sanctioned dispatch path).
- Regression fix landed: `render-document` no longer targets the legacy `documents` table.

### Wave 6 — Hardware Roles + Dispatch Worker
- Tables: `printer_roles`, `printer_role_branch_bindings` (system roles seeded per-org via trigger).
- `print_jobs` extended with `status`, `attempts`, `next_attempt_at`, `dedupe_key` partial-unique index, `dead_letter` / `abandoned` terminal states.
- RPCs: `resolve_hardware_assignment`, `claim_print_jobs`, `requeue_print_job`, `mark_print_job_failed` (exponential back-off).
- Edge fn `dispatch-print-jobs` — the ONLY queue drainer. Scheduled every 60s via `pg_cron` + `pg_net`.
- Admin UI: `/platform/hardware/roles` (CRUD + branch bindings) and Requeue action in `HardwarePrintQueue`.
- Architecture guard: `src/test/architecture/wave6-dispatcher.test.ts` (only dispatcher may call `claim_print_jobs`; only `submitIntent` may insert into `print_jobs`).

> **⚠ Deploy caveat:** the `dispatch-print-jobs` function code is committed but the last redeploy hit `SUPABASE_MAX_FUNCTIONS_REACHED` (100/100 slot cap). The cron will begin executing once Wave 6.5 frees legacy slots (see below). This is the *primary* reason Wave 6.5 must precede Wave 7.

---

## ▶ ACTIVE — Wave 6.5 · Legacy Consolidation Pass

**Why now:** we are at the edge-function quota ceiling (100/100). Wave 7's
convergence requires deploying updates to `dispatch-print-jobs`,
`submit-document-intent`, and `render-document`, plus adding at most one
new fn (`pos-receipt-fastpath`). Nothing can deploy until legacy slots
are freed. The architecture guard `src/test/architecture/edge-fn-inventory.test.ts`
also pins the ceiling at 87 — we are 13 above and failing.

**Scope (in):**

1. **Enumerate legacy edge fns** with the "no live callers except legacy shadow paths" property. Confirmed candidates (verify before delete):
   - `generate-document` — only callers are `src/services/printing/pdfUtils.ts` + `src/services/printing/PrintClient.ts` (both Wave 7 deletions).
   - `generate-payslip-pdf` — check whether `render-document` fully covers it; if yes, callers move to `submitIntent({ documentKind: 'payroll.payslip' })`.
   - `generate-payroll-document` — same test as above.
   - `generate-annual-earnings-statement` / `generate-tax-certificate` / `download-tax-certificate` — inspect for overlap; likely at least one is a thin wrapper we can inline.
   - `override-return-diagnostic` — one-shot diagnostic; confirm not on any live path.
2. **Deduplicate client-side print shims** — `src/services/printing/PrintClient.ts`, `src/hooks/usePrintOrPreview.ts`, `src/hooks/useDocumentPrint.ts`, `ReceiptTemplateGenerator`. This is the client-side twin of the edge-fn dedupe. **Do NOT delete them in this wave** — Wave 7 owns the deletion; Wave 6.5 only marks them `@deprecated`, adds ESLint rules forbidding new imports, and lists every caller.
3. **Free 3+ edge-function slots** so Wave 7 can deploy.
4. **Bump the guard ceiling** in `src/test/architecture/edge-fn-inventory.test.ts` DOWN to the new count once deletes land.

**Scope (out):**
- Consolidating substantive fns that share a superficial name (`send-*-email` family, `mpesa-*`, `post-payroll-gl` vs `post-payroll-payment-gl`, `reverse-payroll` vs `reverse-payroll-payment`). These were already reviewed and rejected — each carries distinct provider URLs, KRA endpoints, FK-ordered logic, or template state. See `src/test/architecture/edge-fn-inventory.test.ts` for the rationale.

**Deliverable checklist:**
- [ ] Written audit doc `docs/audit/2026-wave6.5-legacy-inventory.md` listing every legacy fn/hook/component with its live-caller graph.
- [ ] At least 3 edge fns deleted (target: 5) after zero-caller verification.
- [ ] `@deprecated` JSDoc + ESLint `no-restricted-imports` rules on `PrintClient`, `usePrintOrPreview`, `useDocumentPrint`, `ReceiptTemplateGenerator`.
- [ ] `edge-fn-inventory.test.ts` ceiling lowered to actual count.
- [ ] `dispatch-print-jobs` successfully redeployed (verify via `supabase functions list` + one dry-run cron tick).
- [ ] Plan.md flipped: 6.5 ✅, Wave 7 marked ACTIVE.

---

## ⏸ Wave 7 — POS Receipt Convergence (unchanged, pending 6.5)

Goal: every POS receipt, drawer slip, kitchen ticket and reprint flows
through `submitIntent → output_intent → print_jobs → dispatch-print-jobs → hardware`.
The `PrintClient` / `ReceiptTemplateGenerator` / `useDocumentPrint` stack is deleted.

Full execution plan preserved in git history (previous plan.md revision).
Key subwaves:

- 7.1 Server-side receipt renderer (`thermalReceipt.ts` byte-parity with legacy ESCPOS).
- 7.2 Mechanical caller rewrite (POS hooks, checkout components, label pages).
- 7.3 Delete `PrintClient`, `usePrintOrPreview`, `BrowserHardwareAdapter.print`.
- 7.4 `POS_CHOKEPOINT_V2` feature flag + one-release dual-write.
- 7.5 Architecture guards (no `PrintClient` imports; no client-side `print_jobs` inserts).
- 7.6 Fast-path `pg_net.http_post` invoke from `submit_document_intent` on `scenario='on_close'` (latency ≤2s p95).

**Prereq for entry:** Wave 6.5 checklist fully green AND `dispatch-print-jobs` cron verified firing.

---

## ⏸ Wave 8 — Hardware Adapter Internals
Consolidate `BrowserHardwareAdapter` / Electron `CommandRouter` / `LocalAgent` behind a single `TransportRouter` invariant (already partially done in Phase 5 Step B — see `docs/audit/2026-05-21-hardware-readiness-closeout.md`). Remaining: kill remaining `window.pos.*` reads inside `HardwareClient.ts` (see `host-router-single-source.test.ts` allow-list).

## ⏸ Wave 9 — Legacy Table & Function Deletion
Drop `receipt_settings`, retire the v1 `document_templates` shim, delete edge fns whose only callers were Wave 7 deletions.

---

## 📌 Handoff to next agent — READ FIRST

**Do this before writing any code:**

1. **Verify Wave 6 is truly complete.** Run:
   - `bunx vitest run src/test/architecture/wave6-dispatcher.test.ts`
   - `supabase--read_query` on `printer_roles`, `printer_role_branch_bindings`, `print_jobs` — confirm columns, RLS, and grants match this document.
   - Confirm the pg_cron job exists: `SELECT * FROM cron.job WHERE jobname LIKE '%dispatch-print-jobs%'`.
   - Open `/platform/hardware/roles` and `/platform/hardware/print-queue` in the preview and confirm Requeue works on a `failed` job.
   - If any of the above fails, **stop and fix Wave 6 before proceeding**. Do not start 6.5 on a broken foundation.

2. **Then execute Wave 6.5** exactly as scoped above. The dedupe scope is deliberately narrow — do NOT expand into `send-*-email`, `mpesa-*`, or payroll GL fns (already reviewed & rejected — see the edge-fn-inventory guard's rationale).

3. **Only after 6.5 is ✅**, begin Wave 7. Do not begin any deletion of `PrintClient` before Wave 7.1 (the server-side renderer) is byte-parity green — otherwise POS receipts break.

4. **Never skip waves.** Never work on Wave 8 or 9 while 6.5/7 are open.

5. **Update this file** at the end of every wave. The status table at the top is the single source of truth for stakeholders.

**Constraints that survive across all waves:**
- Every new `public` table needs `GRANT` + `ENABLE RLS` + policies in the same migration.
- No client code inserts into `print_jobs` — only `submit-document-intent` may.
- No client code calls `claim_print_jobs` — only `dispatch-print-jobs` may.
- No new edge fn may be a thin wrapper around another edge fn (see `edge-fn-inventory.test.ts`).
- Hardware ops funnel through `hardwareClient` — no direct `window.pos.*` outside the HostRouter allow-list.

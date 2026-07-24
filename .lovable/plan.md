
# Legal Orders / Garnishments — Continuation Plan

> **Status snapshot (current):** Phases 1–7 delivered end-to-end (recipient master
> data, FSM guard, workspace shell, outbox integration, jurisdiction packs,
> recipient linking, remittance batches, bank-file, settlement, bank-rec
> matching, nightly auto-satisfy, recipient statement print). **Phase 8 backend
> + UI + architecture test + ADR-0097 landed and green.** Only Phase 8 step 2
> follow-up (seed default statutory-report definitions in jurisdiction packs)
> remains before the roadmap is complete.
>
> **Active phase:** Phase 8 (closing).
> **Next milestone:** Phase 8 step 2 follow-up — seed pack-neutral definitions
> (`legal_orders_outstanding_by_recipient`, `legal_orders_remittance_activity`)
> into `legal_order_statutory_report_definitions` with `organization_id = NULL`
> via the KE / ZA / GH / DE localisation packs. After that, extend ADR-0094
> with the audit-projection contract as noted below.

## Phase 0 — Verification of prior work (evidence-based)

Verified directly against DB and codebase, not against `.lovable/plan.md` claims.

| Prior claim | Verification | Status |
|---|---|---|
| Phases 1–5 | Migrations + architecture tests present; ADRs 0092–0094 recorded | ✅ Accepted |
| Phase 6 jurisdiction packs | Resolver, seeded KE/ZA/GH/DE packs, "Packs" tab, `legal-orders-phase6-packs.test.ts`, ADR-0095 | ✅ Accepted |
| Phase 7 step 0 — recipient linking RPCs | Both `SECURITY DEFINER` functions present | ✅ Accepted |
| Phase 7 step 1 — remittance batches | Tables + 7 RPCs present; UI `LegalOrderRemittanceBatches.tsx` mounted; ADR-0096 | ✅ Accepted |
| Phase 7 step 2 — bank-rec seam | `bank_reconciliation_matches.legal_order_remittance_batch_id` + `legal_order_match_batch_to_bank_txn`; `MatchBatchDialog` in workspace | ✅ Accepted |
| Phase 7 step 3 — nightly auto-satisfy + statement | `pg_cron` job `legal-orders-auto-satisfy-nightly` (02:15 UTC), `legal_order_recipient_statement` RPC, "Print / Save PDF" in Recipients | ✅ Accepted |
| Phase 7 step 5 — architecture test | `legal-orders-phase7-remittance-cycle.test.ts` present + green | ✅ Accepted |
| Phase 8 backend | `v_legal_order_audit_timeline` (security_invoker), `legal_order_statutory_report_definitions` (GRANT+RLS+partial unique indexes), `legal_order_running_balance` RPC | ✅ Accepted |
| Phase 8 UI | `LegalOrdersAudit.tsx` mounted at `/hr/payroll/legal-orders/audit`; tab in `LegalOrdersWorkspace`; read-only (no `.update/.insert/.delete`) | ✅ Accepted |
| Phase 8 architecture test | `legal-orders-phase8-audit.test.ts` — 6/6 green | ✅ Accepted |
| Phase 8 ADR | `docs/adr/0097-legal-order-historical-balance-and-reporting.md` | ✅ Accepted |
| Pack-seeded statutory definitions | Rows in `legal_order_statutory_report_definitions` with `organization_id IS NULL` | ⏳ **Pending** |
| ADR-0094 extension for audit projection | Section on `v_legal_order_audit_timeline` shape | ⏳ **Pending** |

## Handoff to the next agent — REQUIRED first steps

Before writing any code, verify the ledger above:

1. Confirm `v_legal_order_audit_timeline`, `legal_order_statutory_report_definitions`
   and `legal_order_running_balance` exist in the live DB and behave as declared
   (view is `security_invoker`, RPC is `SECURITY DEFINER` and calls
   `is_org_member`, table has both partial unique indexes + RLS enabled + GRANTs
   to `authenticated` and `service_role`).
2. Run `bunx vitest run src/test/architecture/legal-orders-phase8-audit.test.ts`
   and confirm 6/6 green. Then run the phase 7 test as well.
3. Load `/hr/payroll/legal-orders/audit` in the app, pick a legal order, and
   confirm the timeline renders lifecycle events + remittance milestones and
   the four balance KPIs update as you change "Balance as of". If any of the
   above fails, stop and fix the regression first — do NOT start new work on
   top of a broken baseline.

Only after verification, resume from the **Next milestone** at the top of this
file. Do not jump to unrelated subsystems; the roadmap below is chronological.

## Phase 7 — Remittance cycle closure (finish)

### Step 2 — Bank reconciliation seam
- Extend `bank_reconciliation_matches` join surface: add nullable `legal_order_remittance_batch_id` FK column + index; when a `bank_transactions` row is matched to a settled batch, populate this instead of a synthetic match.
- Auto-match rule: recipient name / reference / amount against `legal_order_remittance_batches` where `status='settled' AND settled_bank_transaction_id IS NULL`. Rule ships as a `bank_reconciliation_rules` seed, not engine code.
- RPC `legal_order_match_batch_to_bank_txn(_batch_id, _bank_transaction_id)` — SECURITY DEFINER, org-scoped, refuses if batch already matched or txn already reconciled; writes both the match row and stamps `settled_bank_transaction_id`.
- UI on `LegalOrderRemittanceBatches`: "Match to bank transaction" action on settled/un-matched batches → picker over unreconciled bank txns for the batch's org+recipient bank account.

## Phase 7 — Remittance cycle closure (finish)

### Step 2 — Bank reconciliation seam
- Extend `bank_reconciliation_matches` join surface: add nullable `legal_order_remittance_batch_id` FK column + index; when a `bank_transactions` row is matched to a settled batch, populate this instead of a synthetic match.
- Auto-match rule: recipient name / reference / amount against `legal_order_remittance_batches` where `status='settled' AND settled_bank_transaction_id IS NULL`. Rule ships as a `bank_reconciliation_rules` seed, not engine code.
- RPC `legal_order_match_batch_to_bank_txn(_batch_id, _bank_transaction_id)` — SECURITY DEFINER, org-scoped, refuses if batch already matched or txn already reconciled; writes both the match row and stamps `settled_bank_transaction_id`.
- UI on `LegalOrderRemittanceBatches`: "Match to bank transaction" action on settled/un-matched batches → picker over unreconciled bank txns for the batch's org+recipient bank account.

### Step 3 — Recipient statement PDF
- Server function `legal_recipient_statement_pdf({ recipient_id, period_from, period_to })` producing opening balance / accrued / paid / closing balance + per-order line detail.
- Uses existing `document_artifacts` pipeline (ADR-0084) — no direct `pdf-lib` in feature code, honours `no-raw-pdf-lib-in-app` rule.
- Persist artifact, return signed URL. Trigger from Recipient detail and from settled batch.

### Step 4 — Nightly auto-satisfy
- `pg_cron` job `legal-order-auto-satisfy-nightly` calls `/api/public/hooks/legal-orders/auto-satisfy` (TanStack server route) authenticated via `apikey` (Supabase anon), which calls `public.legal_order_auto_satisfy(NULL)` under service role. Route lives under `/api/public/*`.
- Idempotent; emits `legal_order.status_changed` through the existing FSM publisher (no new writer path).

### Step 5 — Architecture tests (`legal-orders-phase7-remittance-cycle.test.ts`)
- Asserts: 7 RPCs present + SECURITY DEFINER; `_legal_order_fsm_guard` still rejects direct `UPDATE ... SET status`; bank-file format enum contains at least `csv`, `ach_stub`, `sepa_pain001_stub`; settlement idempotent (unique `source_event_id` per line); reconciliation join column exists.

## Phase 8 — Audit, reporting, historical balances

### Step 1 — Unified audit projection ✅
- `v_legal_order_audit_timeline` view (security_invoker) — union of `garnishment_lifecycle_events`, `garnishment_audit_log`, `legal_order_event_dispatch_log`, and remittance batch milestones (created/settled/cancelled).
- Ready for consumption by an "Audit" tab on `LegalOrdersWorkspace` and recipient detail (UI wiring pending).

### Step 2 — Statutory reports ✅ (schema)
- `legal_order_statutory_report_definitions` table (org-scoped or platform-wide via NULL `organization_id`), with partial unique indexes for each scope. Owner/admin write, org-member read. Definitions are pack-neutral JSON specs consumed by the reporting centre.
- Follow-up: seed the two default definitions (`legal_orders_outstanding_by_recipient`, `legal_orders_remittance_activity`) via the localisation packs.

### Step 3 — Point-in-time balance ✅
- RPC `legal_order_running_balance(_organization_id, _legal_order_id, _as_of)` returns `total_owed`, `accrued`, `remitted`, `outstanding`, `last_accrual_at`, `last_remittance_at`. `SECURITY DEFINER`, org-gated via `is_org_member`.

### Step 4 — Architecture tests (`legal-orders-phase8-audit.test.ts`) — pending
- Timeline view returns rows for each event class; RLS applied; running-balance RPC deterministic; statutory-definitions table has org+platform uniqueness and role-gated write.

### Step 5 — ADRs — pending
- Extend ADR-0094 with the audit-projection contract.
- New ADR-0097 — Legal Order Historical Balance & Reporting Contract.


## Guardrails (unchanged, enforced by tests)

- All status writes go through `garnishment_transition` / `apply_system_garnishment_transition`; `_legal_order_fsm_guard` remains active.
- Every new `public` table ships GRANT + RLS in the same migration.
- Every new outbox topic ships with a dispatcher entry; unknown topics DLQ.
- No country-specific branching in engine or UI code — pack rows only.
- No direct `pdf-lib` usage in feature code; artifacts flow through `document_artifacts`.
- Server routes for external callers live under `/api/public/*` and authenticate with the Supabase anon key in `apikey` — no bespoke shared secret.

## Execution order

1. Runtime smoke of Phase 7 step 1 (`build → generate → settle`) on a live recipient with outstanding > 0.
2. Phase 7 step 2 (bank rec seam) → step 3 (statement PDF) → step 4 (nightly auto-satisfy) → step 5 (architecture test). ADR-0096 updated with reconciliation seam.
3. Phase 8 step 1 (timeline) → step 2 (reports) → step 3 (running balance) → step 4 (tests) → step 5 (ADRs).

Each step lands as one migration + focused code change with tests green before the next begins.

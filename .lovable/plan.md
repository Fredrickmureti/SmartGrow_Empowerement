
# Legal Orders / Garnishments — Continuation Plan

## Phase 0 — Verification of prior work (evidence-based)

Verified directly against DB and codebase, not against `.lovable/plan.md` claims.

| Prior claim | Verification | Status |
|---|---|---|
| Phases 1–5 (recipient master data, FSM guard, continuity, workspace shell, outbox + finance/ESS subscribers) | Migrations + `legal-orders-phase{2..5}` architecture tests present; ADRs 0092–0094 recorded | Accepted as done |
| Phase 6 jurisdiction packs | `legal_order_effective_kind_defaults` view, resolver, seeded KE/ZA/GH/DE packs, workspace "Packs" tab, `legal-orders-phase6-packs.test.ts`, ADR-0095 | Accepted as done |
| Phase 7 step 0 — recipient linking RPCs (`legal_recipient_link_contact`, `legal_order_attach_contact`) | Both functions present in `pg_proc` | Accepted as done |
| Phase 7 step 1 — remittance batches | Tables `legal_order_remittance_batches` + `legal_order_remittance_batch_lines` exist; all 5 batch RPCs + 2 linking RPCs = 7 SECURITY DEFINER functions present; UI `LegalOrderRemittanceBatches.tsx` mounted; ADR-0096 recorded | Accepted as done |
| Phase 7 step 4 architecture test | `legal-orders-phase7-*.test.ts` does not exist | **Missing** — must be authored before Phase 7 can be declared closed |

Blocking issues found: none in shipped surface. The gap is the *remaining* Phase 7 steps (bank reconciliation match, statement PDF, phase-7 architecture test, nightly auto-satisfy schedule) plus all of Phase 8.

Runtime smoke of `build → generate → settle` on a live recipient is performed once in build mode before authoring Phase 7 step 2, per the handoff checklist in `.lovable/plan.md`.

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

### Step 1 — Unified audit projection
- `legal_order_audit_timeline` view (security_invoker, RLS by org) union of: FSM status transitions (from `business_event_outbox` where `event_type='legal_order.status_changed'`), remittance lines, `finance_integrity_issues` for legal orders, recipient merges (`legal_recipient_merge_log` if present else derived from `commercial_audit_logs`).
- Consumed by a new "Audit" tab on `LegalOrdersWorkspace` and by the recipient detail.

### Step 2 — Statutory reports
- Two pack-neutral report definitions inserted into `payroll_report_definitions`:
  - `legal_orders_outstanding_by_recipient` — over `legal_recipient_outstanding`.
  - `legal_orders_remittance_activity` — over `legal_order_remittance_lines` grouped by period + recipient.
- Both exposed through the existing reporting centre; jurisdictions add packaging via localization packs only.

### Step 3 — Point-in-time balance
- RPC `legal_recipient_running_balance(_recipient_id, _as_of)` — replays accruals (`garnishment_ledger`) − remittances (`legal_order_remittance_lines`) up to `_as_of`. Used by backdated statements and reopened periods; must handle voided remittances.
- Statement PDF (Phase 7 step 3) uses this RPC for opening balance.

### Step 4 — Architecture tests (`legal-orders-phase8-audit.test.ts`)
- Timeline view returns rows for each event class; RLS applied; running-balance RPC deterministic across replays; report definitions registered.

### Step 5 — ADRs
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

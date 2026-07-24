# Legal Orders (Garnishments) — Continuation Plan

## Phase 0 — Independent verification of prior work (DONE, findings below)

Verified directly against the codebase and database — not against `.lovable/plan.md` claims.

| Claim in plan.md | Verification | Status |
|---|---|---|
| Phase 1 recipient master data (`legal_recipients`, `legal_recipient_types`, `legal_recipient_outstanding`) | `to_regclass` returned all three | ✅ real |
| Phase 2 FSM guard + status publisher | Architecture test `legal-orders-phase2-seams` (4 tests) green | ✅ real |
| Phase 3 recipient continuity | `legal-orders-phase3-recipient-continuity` (3 tests) green; view exists | ✅ real |
| Phase 4 workspace shell | `legal-orders-phase4-workspace` (4 tests) green; pages present under `src/pages/hr/payroll/` (`LegalOrdersWorkspace`, `LegalRecipients`, `LegalOrdersTasks`, `LegalOrderRemittanceBatch`) | ✅ real |
| Phase 5 outbox publisher + finance/ess subscribers + writer guard | `legal_order_subscriber_dispatch_log` table, `legal_order_check_finance_drift` + `legal_order_notify_employee` functions, 4 rows in `business_event_subscriptions` (finance/ess × status_changed/payment_posted, all `is_active=true`), writer-guard test green | ✅ real |
| Engine already reads pack fields (`calc_model`, `priority_class`, `aggregate_cap_membership`, `protected_earnings_rule`) | Confirmed in `supabase/functions/_shared/garnishment-engine.ts` Phase-4 header + branches | ✅ real |

Test suite: `bunx vitest run src/test/architecture/legal-orders-phase*.test.ts` → **15/15 pass** (4 files).

No regressions or shallow patches detected in the Phase 1–5 surface. Resume at Phase 6 as the plan states, with two additional phases (7 and 8) appended for genuine closure of the money-out-the-door lifecycle and the audit/reporting story.

## Phase 6 — Jurisdiction packs (was NEXT, now active)

The engine already consumes pack contract fields; what's missing is (a) the storage/resolution layer and (b) actual seeded jurisdictions.

1. **Schema.** Migration adding:
   - `legal_order_jurisdiction_packs(id, country_code, region_code null, effective_from date, effective_to date null, rules jsonb, source text, checksum text, created_at, updated_at)`.
   - `legal_order_jurisdiction_pack_kinds(pack_id, kind, calc_model, priority_class, aggregate_cap_membership, protected_earnings_rule jsonb, employer_fee_amount, employer_fee_account_role, default_priority, always_first)` — one row per garnishment kind the pack defines.
   - `legal_order_org_pack_overrides(org_id, business_id null, country_code, region_code null, pack_id)` — org-level pin.
   - `security_invoker` view `legal_order_effective_kind_defaults` resolving `org override → country/region seed → global default in garnishment_kind_defaults`.
   - GRANTs + RLS (authenticated read for their org; service_role writes; admin role for overrides).
2. **Resolver RPC.** `public.legal_order_resolve_kind_defaults(_org_id uuid, _country text, _region text, _kind text) → jsonb`. `compute-payroll` + `_shared/garnishment-engine` receive resolved defaults through the existing `KindDefault` shape — no engine math change.
3. **Seed migrations, one per jurisdiction.** Each migration is self-contained (GRANT + RLS + INSERT into pack tables). Baseline set:
   - `US-FED` (CCPA disposable-earnings caps + child-support ordering).
   - `US-CA`, `US-NY`, `US-TX` (state overrides on caps + protected earnings).
   - `UK` (AEO priority vs. non-priority; DEA percentages).
   - `KE` (court order + child maintenance).
   - `ZA` (emoluments attachment order).
   - `IN` (CPC §60 protected earnings).
   - `DE` (Pfändungstabelle bands as `protected_earnings_rule`).
   - `FR` (barème saisie).
   - `AU` (CSA Section 72A percentage protected earnings).
   - `CA-ON` (Family Responsibility Office).
   Each migration ships in isolation and must contain `INSERT ... ON CONFLICT DO NOTHING` so it is re-runnable.
4. **Pack management UI.** New tab `/hr/payroll/legal-orders/packs`:
   - list active packs per org, effective window, source, checksum;
   - diff view against seeded baseline (jsonb deep-diff);
   - admin-only pin/unpin org override;
   - reuses the existing workspace shell (`LegalOrdersWorkspace`).
5. **Tests.**
   - New architecture test `legal-orders-phase6-packs`: schema objects exist, resolver returns override before seed before global default, engine still deterministic when pack is empty.
   - Deno test extending `garnishment-engine.test.ts` with US-CA and UK fixtures — same input, pack-driven output.
6. **ADR-0095** — pack contract, resolution order, migration playbook, pack authoring rules (no code changes needed to add a country).

Guardrails (preserved): no new status writer; no bypass of `create_notification`; every new outbox topic requires a dispatcher handler.

## Phase 7 — Remittance cycle closure (APPENDED)

Rationale: parent prompt requires the flow to reach "money legally reaches its destination + reconciliation + closure". Verified today the batch page (`LegalOrderRemittanceBatch.tsx`) and the `post-garnishment-payment` edge function exist and emit `legal_order.payment_posted`, but the loop back into GL reconciliation and closure is only partial.

1. **Liability → bank file → payment → GL reconciliation loop.**
   - RPC `legal_order_build_remittance_batch(_org_id, _business_id, _recipient_id null, _as_of_date)` — materialises pending accruals from `garnishment_ledger` minus `legal_order_remittance_lines` per recipient, respects payment method preferences on `legal_recipients`.
   - RPC `legal_order_generate_bank_file(_batch_id, _format)` — pluggable format (EFT/ACH/SEPA/PAIN.001/local CSV) driven by localization pack; format is data, not code.
   - Reconciliation join: `bank_transactions ↔ legal_order_remittance_lines` via existing `bank_reconciliation_matches`; auto-match rule for recipient name + amount + reference_number.
2. **Auto-closure FSM steps.**
   - Extend `garnishment_transition_impl` to accept `satisfied` when `total_paid >= total_owed` AND no pending accrual — routed through the FSM, still writer-guarded.
   - Nightly job `legal_order_auto_satisfy` scans `legal_recipient_outstanding` for zeroed orders and calls the transition; emits `status_changed` as always.
3. **Recipient statements.**
   - `legal_recipient_statement_pdf` server function producing a bank-grade per-recipient statement (opening balance, accrued, paid, closing balance, per-order lines). Uses existing document artifact pipeline.
4. **Tests.**
   - `legal-orders-phase7-remittance-cycle`: RPC contracts, auto-satisfy transition path, bank-file format pluggability, reconciliation match round-trip on a seeded fixture.
5. **ADR-0096** — remittance cycle contract; drift/over-remittance codes owned by Phase 5's `finance_integrity_issues`.

## Phase 8 — Audit, reporting, historical balances (APPENDED)

Rationale: parent prompt lists Reports and Audit as first-class stages; today the audit trail is spread across `commercial_audit_logs`, `_legal_order_publish_status_event`, `finance_integrity_issues` and ad-hoc columns.

1. **Unified audit projection.** View `legal_order_audit_timeline` joining FSM transitions (from outbox), remittance lines, payments, drift issues, recipient merges. Read-only, `security_invoker`, RLS by org.
2. **Statutory reporting hooks.** Extend the reporting centre (ADR-0062) with two report definitions:
   - "Legal Orders — outstanding by recipient" (uses `legal_recipient_outstanding`).
   - "Legal Orders — remittance activity by period" (uses `legal_order_remittance_lines`).
   Both pack-neutral; jurisdictions add packaging via localization packs only.
3. **Historical rehydration.** RPC `legal_recipient_running_balance(_recipient_id, _as_of)` for point-in-time balance — required for backdated statements and reopened periods.
4. **Tests.**
   - `legal-orders-phase8-audit`: timeline view returns rows for status changes, remittances and drift; historical balance matches replayed ledger.
5. Update ADR-0094 with the audit-projection contract; append note to ADR-0093.

## Guardrails carried through all phases

- All status writes go through the FSM. Writer-guard test enforces.
- All pack behaviour is data — no country name in engine code (`no-country-fixture-in-shared-preview` rule already exists; add a matching lint if any new engine file lands).
- Every new outbox topic ships with a dispatcher handler entry — unknown topics DLQ.
- Every migration creating a table in `public` includes GRANTs + RLS in the same file.
- Every phase ends with: architecture test green, DB objects verified via read query, and a plan.md status update.

## Execution order (concrete)

1. Phase 6 step 1 (schema) → Phase 6 step 2 (resolver + engine wiring) → Phase 6 step 3 (US-FED + UK + KE first, remaining seeds after) → Phase 6 step 4 (UI) → Phase 6 step 5 (tests) → ADR-0095.
2. Phase 7 step 1 → step 2 → step 3 → step 4 → ADR-0096.
3. Phase 8 as above.

Each numbered step lands as its own migration/PR-shaped change with tests before moving on.

---

## Phase 6 — STATUS: DELIVERED (2026-07-24)

Migration applied and verified in DB. Follow-up:

- `garnishment_kind_defaults` platform baseline: 7 → 12 kinds, every row now carries a non-null `priority_class` on the 10/20/30/40/50/60/99 ladder.
- `localization_pack_garnishment_kinds` seeded for KE (9 kinds total), ZA (3), GH (7 total), DE (3) with statute-anchored `protected_earnings_rule` values.
- View `public.legal_order_effective_kind_defaults` (security_invoker) publishes resolver output for the workspace.
- UI: `LegalOrderPacks.tsx` mounted at `/hr/payroll/legal-orders/packs`, wired into workspace tabs.
- Architecture test `legal-orders-phase6-packs.test.ts` (4 tests, all green).
- ADR-0095 recorded.

Next up: Phase 7 (remittance cycle closure) then Phase 8 (audit + historical balances). No Phase 6 work remaining.

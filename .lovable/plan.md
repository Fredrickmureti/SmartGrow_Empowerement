
# Legal Orders (Garnishments) — Enterprise Subsystem Program

Scope: take the existing garnishment stack (already has FSM, engine, ledger, remittance view, evidence, audit, cap-exempt, always-first, `legal_orders` view) and close the enterprise gaps: recipient master data, liability→remittance→bank→reconciliation continuity, priority/aggregate-cap engine hardening, and an operational workspace. Country behaviour stays pack-driven; nothing is hard-coded.

Current-state facts confirmed by reading the code (before proposing anything):

- Domain tables exist: `legal_orders_records`, `legal_order_authorities`, `legal_order_kind_overrides`, `legal_order_documents`, `legal_order_remittance_lines`, `legal_order_event_dispatch_log`, `garnishment_kind_defaults`, `garnishment_carry_forward`, `garnishment_lifecycle_events`, `garnishment_audit_log` (via `admin_audit_log`), plus `payroll_liabilities` with `payee_contact_id`. There is a `public.legal_orders` read view and a `garnishment_ledger` view.
- Recipient linkage today is `legal_orders_records.payee_contact_id → contacts.id` with a `payee_unmapped` trigger. Remittance batch page reads `payee_payment_method_id` off `legal_orders`. There is **no** dedicated payee/vendor abstraction for third-party legal recipients, and no dedupe/merge across employees.
- Engine + FSM live in migrations + `garnishment-engine.test.ts`; UI at `src/pages/hr/payroll/Garnishments.tsx` (812 lines) and `LegalOrderRemittanceBatch.tsx` (289 lines, read-only). The batch page does not close the loop to bank file → payment → reconciliation → order ledger.

## Phased execution

### Phase 1 — Domain model & recipient master data
1. Introduce a first-class **Legal Recipient** aggregate (`legal_recipients`) as the enterprise abstraction (Court, Child-Support Agency, Tax Authority garnishment desk, Creditor, Collection Agency, Bank trustee, SACCO). Backed by a `contacts` row (single vendor identity) + typed recipient metadata (recipient_type from pack, jurisdiction, remittance schedule, statement cadence, required references, cap-exempt default, always-first default). Prevents duplicates across employees while keeping many orders → one recipient.
2. Add `recipient_id` to `legal_orders_records` (nullable during backfill), backfill from existing `payee_contact_id` + `authority_id`, dual-write, then flip reads to `recipient_id`. Keep `payee_*` columns for API stability (documented as denormalized snapshots).
3. Pack-driven `legal_recipient_types` seeded per localization pack (no hard-coded lists in code). `garnishment_kind_defaults` continues to drive kind behaviour; recipient type drives remittance/statement behaviour.
4. Enforce uniqueness `(organization_id, contact_id, recipient_type, jurisdiction)` and a merge RPC for duplicates.

### Phase 2 — Lifecycle & engine hardening
1. Codify the full FSM in one canonical RPC (`legal_order_transition`) — draft → pending_approval → approved → active → (suspended ↔ active) → satisfied/released/expired/terminated_unsatisfied. Guarded by evidence-required, SoD approval, and pack completion_rule (until_end_date / until_total_owed_met / indefinite / manual_release_only).
2. Move all priority + aggregate-cap + always-first + per-order-cap + minimum-take-home logic into a single `garnishment_engine` SQL function invoked by `compute-payroll`. Delete any duplicated logic in TS. Emit deterministic `payslip_lines` with a structured `explain` blob (rule, inputs, applied cap, carry-forward reason).
3. Carry-forward: unpaid balance → `garnishment_carry_forward` with a reason code; next-period engine consumes it before new obligations. Add end-of-life reconciliation into `total_paid`/`balance_remaining` on the order.

### Phase 3 — Financial continuity (Liability → Remittance → Bank → GL → Recon)
1. Per-recipient liability accounts auto-provisioned via `default_account_settings` (role: `garnishment_payable`) — one child liability per recipient, parented to a single control account. Trigger guard (ADR-0022 pattern) prevents mapping garnishment_payable to a non-liability or COGS account.
2. Post-payroll GL: one credit per `(recipient, order)` liability line, one debit to `garnishment_expense`/wage-clearing, so recipient-level statements reconcile without joining payroll tables.
3. Remittance batch becomes writable: select period + recipient(s) → generate `payroll_remittance_payments` grouped by recipient + payment method → produce bank file via existing `payroll_bank_files` pipeline → post cash JE on file settlement → close remittance lines and write back to `legal_order_remittance_lines.paid_batch_id`.
4. Partial payments, cancellations, and reversals flow through `payment_reversal_events` and update carry-forward automatically.
5. Recipient statements: `legal_order_recipient_statement` view (opening balance, period debits from payroll, period credits from remittances, closing balance), used by both the operator workspace and the recipient-facing PDF artifact.

### Phase 4 — Operator workspace (UX)
Replace the current single-page CRUD with a task-oriented workspace under `/hr/payroll/legal-orders`:
1. **Overview** — KPIs (active orders, pending approval, missing evidence, overdue remittances, unmapped recipients, cap-exempt count, always-first count, orders satisfied this period), with drilldowns.
2. **Orders** — filterable list (status, kind, recipient, priority_class, employee, missing evidence). Row detail = tabs: Details · Compliance · Ledger · Documents · Lifecycle · Events.
3. **Recipients** — master list, dedupe/merge, statements, contact quality flags.
4. **Remittance batches** — period picker → grouped by recipient → build batch → send to bank file pipeline → track settlement → download recipient statement.
5. **Reports** — statutory reports (per pack), aged outstanding, satisfied this period, terminated unsatisfied, evidence gaps, exceptions.
6. **Audit** — unified event stream from `garnishment_lifecycle_events` + `admin_audit_log` + `payment_reversal_events` for a given order/recipient.

Design principles: enterprise operational density, no chat/AI surfaces, keyboard-first, every screen answers "what needs attention now?".

### Phase 5 — Cross-domain integration & guardrails
1. Event outbox: publish `legal_order.*` domain events (created, approved, activated, deducted, remitted, satisfied, released, terminated) on `business_event_outbox` for downstream (notifications, ESS, external integrations).
2. ESS (`/me/legal-orders`): employee-facing view of their own orders, deductions, and remittance status — read-only, RLS-scoped.
3. Architecture tests: no duplicate business rules (single engine RPC), no hard-coded country strings, no direct writes to `legal_orders_records` bypassing FSM, garnishment_payable mapping trigger present.
4. Docs: ADR 0093 (Recipient master data), ADR 0094 (Remittance closure), operator manual under `docs/manuals/hr-payroll/`.

## Verification per phase

- Phase 1: dual-read backfill parity check; unique constraint holds; merge RPC pgTAP tests.
- Phase 2: engine golden tests (existing `garnishment-engine.test.ts` extended); FSM pgTAP; property test that priority + always-first + cap-exempt + take-home floor are deterministic across permutations.
- Phase 3: end-to-end integration test — post payroll → assert per-recipient liability lines → build batch → simulate bank settlement → assert order `total_paid`, carry-forward, and recipient statement match to the cent.
- Phase 4: Playwright walkthrough of each workspace tab against a seeded fixture.
- Phase 5: outbox test + arch tests green.

## Explicit non-goals

- No changes to statutory (PAYE/NSSF/SHIF/AHL/NITA) mapping or accounts. `Garnishment Payable ≠ PAYE Payable` (ADR-0092) stands.
- No country logic in code — all recipient types, kinds, priority classes, evidence rules, and completion rules stay in localization packs.
- `payee_*` snapshot columns and existing RPC/API surface remain for backward compatibility during the transition.

## Technical details (for engineers)

- New tables: `legal_recipients`, `legal_recipient_types` (pack-seeded), `legal_order_recipient_statement` view, `garnishment_expense` role.
- New/changed RPCs: `legal_order_transition`, `garnishment_engine`, `legal_recipient_merge`, `build_legal_order_remittance_batch`, `close_legal_order_remittance_batch`.
- New guard triggers: role check for `garnishment_payable`, prevent-direct-status-write on `legal_orders_records`.
- Client: new hooks `useLegalRecipients`, `useLegalOrderStatement`, `useLegalOrderRemittanceBatch` (writable). Retire ad-hoc `payee_*` writes from the editor.
- Migrations sequenced additive-first (add columns/tables, backfill, dual-write, cutover, drop legacy) to keep production safe.

Phase 1 begins on approval; each subsequent phase is gated on the previous phase's verification passing.

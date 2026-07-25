# Approval & Governance Consolidation

## Execution status (living)

**Active phase:** Phase 4 — module migration (start with App Access).
**Next up:** replace `useAppAccessRequest` + `AppAccessApprovalsInbox` bespoke flow with `routeApproval` / `decideApproval` from `src/lib/governance/approvalEngine.ts`; delete the module's local approval status tracking; re-point its inbox to the shared `approval_requests` reader.

### Completed
- **Phase 0 — Inventory.** Audit at `docs/audit/approval-governance-inventory.md`.
- **Phase 1 — Registry.** `public.governance_action_registry` (RLS, platform-admin write-gated) seeded with all 43 `SELF_ACTION_CATALOGUE` keys. Soft trigger on `approval_rules.action_name`. Hook `src/hooks/governance/useGovernanceActionRegistry.ts`. Guard `src/test/architecture/governance-action-registry-parity.test.ts`.
- **Phase 2 — Engine schema hardening.** Workflow versioning; request snapshots + idempotency; append-only hash-chained `approval_history` with `approval_history_verify(uuid)` integrity RPC; hard FK `approval_rules.action_name → governance_action_registry(action_key)` (soft trigger dropped). Guard `src/test/architecture/approval-engine-schema.test.ts`. Doc `docs/audit/approval-governance-phase-2.md`.
- **Phase 3 — Single entry points.** `public.approval_route(...)` and `public.approval_decide(...)` SECURITY DEFINER RPCs with `governance_assert_not_self` self-approval guard, terminal-state protection, and `business_event_outbox` emission (`approval.routed`, `approval.<terminal>`). Direct `INSERT/UPDATE/DELETE` on `approval_requests` / `approval_history` revoked from `authenticated` + `anon`. Client helper `src/lib/governance/approvalEngine.ts`. Guard `src/test/architecture/approval-engine-entrypoints.test.ts` forbids any other file from embedding the RPC names. Doc `docs/audit/approval-governance-phase-3.md`.

### Pending (the roadmap section below is authoritative)
- Phase 4 — module migration in the documented order (App Access → finance write-side → posting side → inventory → sales/procurement → HR/payroll → payroll runs).
- Phase 5 — unified UI (Settings→Governance, Studio→Approvals, global "My Approvals" inbox, standard `<ApprovalStatusPanel />`).
- Phase 6 — security hardening (rate limits, integrity monitor, pgTAP coverage, delegation loop detection, escalation SLAs, multi-step workflow advancement).
- Phase 7 — retirement of bespoke hooks/pages listed in Phase 4 and duplicated `automated_actions` approval branch.

### Hand-off for the next agent
1. **Verify Phases 1–3 before writing any new code.** Run:
   - `bunx vitest run src/test/architecture/governance-action-registry-parity.test.ts src/test/architecture/approval-engine-schema.test.ts src/test/architecture/approval-engine-entrypoints.test.ts src/test/architecture/sod-coverage.test.ts`
   - `bun run tsgo`
   - DB sanity: `SELECT count(*) FROM governance_action_registry;` = 43; `approval_route`/`approval_decide` present in `pg_proc`; `has_table_privilege('authenticated','public.approval_requests','INSERT')` = `false`.
2. Read `docs/audit/approval-governance-phase-2.md` and `docs/audit/approval-governance-phase-3.md` end-to-end.
3. **Do not** open Phase 5/6/7 early or touch unrelated modules. Phase 4 is one module at a time, in the roadmap order, with the bespoke hook fully deleted before moving on.
4. Start Phase 4 with App Access: `useAppAccessRequest` and `AppAccessApprovalsInbox` become thin wrappers over `routeApproval` / `decideApproval`; add the `app_access.grant` action key to both `SELF_ACTION_CATALOGUE` and the registry migration (the Phase 1 parity guard will demand both). Ship a smoke test per migrated module.

---


Goal: collapse the current mix of governance-mode/self-action guards, `approval_rules` + `approval_workflows` + `approval_requests` + `approval_history` + `approval_rule_logs`, `automated_actions`, per-module approval hooks (`useApprovalGate`, `useSalesOrderApproval`, procurement recommendations, app-access approvals, payroll control center, physical count, stock adjustment, loans, expenses, bills, POs, refunds, credit notes, JEs) and the Studio "Approval Rules" surface into one canonical Approval & Governance platform that every module consumes.

Investigation so far confirms multiple co-existing surfaces:

- **Governance layer (DB-native, mature):** `organizations.governance_mode` (solo/standard/strict), `self_action_policy`, `self_action_overrides`, `governance_assert_not_self` / `governance_assert_not_subject`, per-table `sod_<table>_guard` triggers, `selfActionCatalogue.ts`, `sod-coverage.test.ts`, `SelfActionOverrideDialog`, `BlockedAttemptsQueue`, `parseGovernanceError`. This is the strongest existing pillar.
- **Rule/workflow layer:** `approval_rules` (20 cols), `approval_workflows` + `approval_workflow_steps`, `approval_requests`, `approval_history`, `approval_rule_logs`, plus `automated_actions` / `automated_action_steps` / `automated_action_logs` / `automation_execution_tracker`. Managed from `ApprovalRulesManager` in Studio.
- **Per-module ad-hoc engines:** `useApprovalGate`, `useSalesOrderApproval`, `useProcurementRecommendations`, `AppAccessApprovalsInbox` + `useAppAccessRequest`, payroll approval paths, expense/bill/PO approval status banners.
- **Event bus already present:** `business_event_outbox` + `business_event_subscriptions` + `business_event_topics` — the correct integration seam.

## Target architecture (canonical)

```text
Business Event (module)                 ← "loan.submitted", "bill.submitted", ...
        │
        ▼
Approval Router (RPC: approval.route)   ← reads approval_rules for (org, event, scope)
        │
        ▼
Workflow Instance = approval_requests   ← 1 row per business event needing approval
        │  ├─ steps hydrated from approval_workflow_steps (rule snapshot, immutable)
        │  ├─ SoD pre-check via governance_assert_not_self (existing helper)
        │  └─ notifications enqueued via business_event_outbox
        ▼
Approver decision RPC (approval.decide)
        │  ├─ SoD re-check (defense in depth)
        │  ├─ writes approval_history (append-only, hash-chained)
        │  └─ transitions request state (pending → approved/rejected/escalated)
        ▼
Terminal state → emits "<event>.approved"/"rejected" to business_event_outbox
        │
        ▼
Module executors subscribe (payroll.post, bill.pay, loan.disburse, ...)
```

Ownership:
- **Governance workspace** owns policy: modes, self-action policy matrix, overrides, delegations, escalation SLAs, emergency-break-glass. Consumed by the engine, never bypassed.
- **Approval engine** owns request lifecycle: rule matching, workflow instancing, step evaluation, decision recording, history.
- **Modules** own only: emitting the business event, and executing on the terminal outbox event. No module keeps its own approval table, its own "pending approvals" list, or its own self-check.
- **Audit** is one immutable stream: `approval_history` (per-request) + `audit_logs` (governance & override events) + `business_event_outbox` (integration). No new per-module logs.

## Phases (executed sequentially, each verified before the next)

### Phase 0 — Deep inventory (read-only, no code changes)
Trace every current call site with subagents; produce internal maps (kept in `docs/audit/approval-governance-inventory.md`) of: every table, RPC, trigger, hook, page, and their overlaps. Deliverable is the truth table that drives every later phase; nothing ships without it.

### Phase 1 — Canonical entity & action registry
- Promote `selfActionCatalogue.ts` to a single `governance_action_registry` (DB table + typed TS mirror generated from it). Every approval-capable business event (loan.submit, bill.approve, po.approve, payroll.post, stock_adjustment.approve, credit_note.issue, journal.post, expense.approve, app_access.grant, refund.issue, etc.) is one row: `{ action_key, module, subject_table, severity_default, sod_rule, description }`.
- Replace scattered enums / string literals in hooks and triggers with references to this registry. Architecture test forbids literal action codes outside the registry (extends existing `no-literal-rule-codes-in-engines`).

### Phase 2 — Canonical rule + workflow schema
- Keep `approval_rules`, `approval_workflows`, `approval_workflow_steps`, `approval_requests`, `approval_history`, `approval_rule_logs` as the canonical tables; retire `automated_actions*` for approvals (keep only for non-approval automations) or fold into the same engine with a discriminator.
- Introduce `approval_requests.rule_snapshot jsonb` + `workflow_snapshot jsonb` so historical decisions never change when a rule is edited (policy versioning). `approval_history` becomes append-only and hash-chained (`prev_hash`, `row_hash`) for audit immutability.
- Add missing invariants: no self-approval (uses `governance_assert_not_self`), no circular delegation, single-use overrides (already enforced), replay-protected decision RPC (idempotency key from request + step + actor).

### Phase 3 — Approval engine RPCs (single entry points)
Create `public.approval_route(event_key, subject_ref, context jsonb)` and `public.approval_decide(request_id, step_id, decision, note, override_id?)`. Both are SECURITY DEFINER, both re-check governance, both write to `business_event_outbox` on terminal state. All modules move to these two RPCs; direct writes to `approval_requests` / `approval_history` are revoked from `authenticated` and `anon`.

### Phase 4 — Module migration (in dependency order)
Replace per-module gates with the engine. One module per PR, each verified via existing architecture tests + a new e2e smoke:
1. App Access (smallest, self-contained) — retire `AppAccessApprovalsInbox` bespoke flow onto engine.
2. Expenses, Bills, POs, Credit Notes, Refunds (finance write side).
3. Journal Entries, Payments (finance posting side).
4. Stock Adjustments, Physical Counts, Stock Transfers (inventory).
5. Sales Orders (retire `useSalesOrderApproval`), Procurement recommendations.
6. Loans, Advances, Compensation Changes, Contracts, Timesheets, Leave (HR/payroll).
7. Payroll runs — last, because the control center is the most entangled.

After each module: delete the bespoke hook + inbox page and re-point UI to the single "My Approvals" inbox.

### Phase 5 — Unified UI surfaces
Two workspaces, no others:
- **Settings → Governance** (extends existing `GovernanceSoD.tsx`): Mode card, action-policy matrix (driven by registry), delegations, override log, blocked-attempts queue. No rule authoring here.
- **Studio → Approvals** (extends `ApprovalRulesManager`): rule authoring, workflow designer, escalation SLAs, rule simulation ("what would happen if…"), rule change audit. No policy toggles here.
- One **"My Approvals" inbox** (top-level nav) replaces every module's pending list; it queries `approval_requests` filtered by current approver and shows subject-record peek via existing `useSalesDocumentRecord`-style generic fetcher.
- Every module's object page gains a standard `<ApprovalStatusPanel />` that reads from `approval_requests` for that subject; the bespoke `ApprovalStatusBanner` is retired to it.

### Phase 6 — Security hardening
- Revoke direct `INSERT/UPDATE/DELETE` on `approval_*` from `authenticated`; only the two RPCs may write.
- Rate-limit `approval_decide` per actor; reject decisions on terminal requests.
- Enforce hash-chain continuity in a nightly integrity job (extends the existing `finance_integrity_issues` pattern into `governance_integrity_issues`).
- Add pgTAP coverage for: self-approval refusal, override single-use, replay rejection, escalation on SLA breach, delegation loops, cross-org isolation.

### Phase 7 — Retirement & cleanup
Delete: bespoke approval hooks/pages listed in Phase 4, duplicated `automated_actions` approval branch, any migration seed that hard-codes action keys outside the registry. Architecture tests block regressions.

## Verification gates (per phase)

- `bun run tsgo` clean.
- `bunx vitest run` for `src/test/architecture/*` (existing SoD coverage + new registry/engine tests).
- `supabase--linter` clean; new pgTAP suites green.
- Manual smoke via Playwright on the migrated module's approve/reject/override path before moving on.

## Out of scope (explicitly)

- No UI redesign beyond consolidation; keep existing tokens/components.
- No new notification channel; use existing `business_event_outbox` subscribers.
- No changes to non-approval automations in `automated_actions`.
- No migration of historical `approval_history` rows — new hash chain starts at engine cut-over, old rows preserved read-only.

## Technical notes

- Registry table: `governance_action_registry(action_key pk, module, subject_table, severity_default, sod_rule, description, created_at)`. TS mirror generated at build time (script in `scripts/`) so `selfActionCatalogue.ts` becomes generated, not hand-edited.
- Hash chain: `row_hash = sha256(prev_hash || request_id || step_id || decision || actor || decided_at)`.
- Idempotency: `approval_decide` accepts `client_token uuid`; unique index on `(request_id, step_id, client_token)`.
- Outbox topics registered in `business_event_topics` per action_key; subscribers in `business_event_subscriptions` route to module executors.
- Existing `governance_assert_not_self` / `_not_subject` are reused verbatim inside the engine RPCs — no parallel implementation.

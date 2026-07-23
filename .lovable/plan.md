
## Phase 1 — Verification of prior agent (2026-07-22 → 2026-07-23)

Cross-checked `.lovable/plan.md` against the live DB and repo. Every claim marked "Confirmed / DONE" through Phase 6b holds up:

- DB objects present: `legal_orders` view, `legal_order_authorities`, `legal_order_documents`, `legal_order_remittance_lines`, `legal_order_event_dispatch_log`; RPCs `legal_order_transition`, `garnishment_transition`, `install_legal_order_kind_defaults`, `legal_order_apply_payment_remittance`, `legal_order_notify_event` all exist.
- `garnishment_kind_defaults` has `calc_model` + `protected_earnings_rule`; `employee_garnishments.authority_id` FK present.
- `business_event_topics` seeded with 11 `legal_order.*` rows (column is `topic_prefix`, not `topic` — plan wording aside, seed is correct).
- `supabase/functions/outbox-dispatcher/index.ts` registers handlers for all 11 topics.
- UI artifacts exist: `src/hooks/useLegalOrders.ts`, `src/components/payroll/AuthorityPicker.tsx`, `src/components/payroll/LegalOrderDocuments.tsx`.
- Shared engine already extended (`calc_model`, `priority_class`, `aggregate_cap_membership`, `protected_earnings_rule`, `always_first`, effective-window).

No contradictions found. The genuinely completed milestone is **Phase 6b**. Remaining scope is what the plan already named: Phase 6c (reporting rebind) and Phase 7 (cleanup), plus the gaps below that surfaced during verification.

## Phase 2 — Additions / corrections

1. **Approval-workflow auto-seed + auto-request (gap B from prior plan).** The FSM enforces an approved `approval_request` when a workflow exists, but no seed/UI creates one. Without it the gate is a no-op. Add on first legal-order install: create a default `approval_workflows` row for `entity_type='legal_order'` if the pack's `self_action_policy` requires approval, and have `legal_order_transition('submit', …)` auto-insert a pending `approval_requests` row.
2. **Context UI polish still owed from Phase 5.** `Garnishments.tsx` form: dynamic calc fields per `calc_model` (fixed | percent_disposable | lesser_of | statutory_formula placeholder), completion-rule gating (`by_date` requires end_date, `by_balance` requires total_owed, `indefinite` hides both), and dashboard badges (`priority_class`, `always_first`, missing-evidence, pending-approval). Hooks + read paths already exist; work is presentational.
3. **`post-payroll-gl` should read the `legal_orders` view** for payee/authority hydration so `authority_name`, `calc_model`, `priority_class` are always resolved and the eventual `authority_id`-only world doesn't break the ledger.
4. **`Garnishments.tsx` label / route.** Add `/hr/payroll/legal-orders` as the primary route with `/hr/payroll/garnishments` as alias; update sidebar copy. (Alias route exists per prior claim; verify + rename primary.)
5. **Reporting integration test.** One test rendering a statutory return with two orders (child_support + tax_levy) asserting `priority_class` ordering, using the projection.

## Phase 3 — Execution order (resume here)

### Step A — Phase 6c: reporting rebind
- Rewrite reporting/vendor-statement reads in `supabase/functions/post-payroll-gl/index.ts` (line ~1019 hydration query) and any statement export to select from `public.legal_orders` view + `public.legal_order_remittance_lines` projection instead of `employee_garnishments`.
- Keep FSM/write paths on the physical table: `compute-payroll` mutations (`total_paid`) and `post-garnishment-payment` updates stay as-is.
- Update `payroll_return_runs` extract to join the view so `authority`, `priority_class`, `calc_model` are always resolved (grep confirms no current binding — add one when the return extract touches garnishments).
- Add integration test: two orders (child_support, tax_levy), assert projection order = `priority_class`.
- Update audit doc `docs/audit/2026-07-22-legal-orders.md` with 6c summary; update `.lovable/plan.md`.

### Step B — Approval workflow seed + auto-request (gap 1)
- Migration: on first `install_legal_order_kind_defaults` for an org where `self_action_policy.mode='require_approval'` for `payroll.legal_order.activate`, insert a default `approval_workflows` row for `entity_type='legal_order'` with one step (role: `owner` or `admin`).
- Extend `legal_order_transition` (`action='submit'`) to auto-insert a pending `approval_requests` row referencing the target order when a workflow exists and none is pending.
- Test: submit → pending row appears; approve → activate succeeds; no workflow → submit still transitions (backward compatible).

### Step C — UI polish (gap 2)
- `Garnishments.tsx`: swap static calc block for a `calc_model`-driven renderer (reuses resolved kind row from `useLegalOrders`).
- Completion-rule gating on the form.
- `GarnishmentDashboard.tsx`: badges (`priority_class`, `always_first`, missing-evidence, pending-approval), sourced from the view.
- Route: promote `/hr/payroll/legal-orders` to primary; alias `/hr/payroll/garnishments`; sidebar label "Legal Orders".

### Step D — Phase 7 cleanup (only after A–C green)
- Drop free-text `issuing_authority` after backfill check (`SELECT count(*) FROM employee_garnishments WHERE authority_id IS NULL AND issuing_authority IS NOT NULL` must be 0; if not, backfill via migration first).
- Rename `employee_garnishments` → `legal_orders_records`; preserve `public.legal_orders` view name for consumers; update code refs.
- Delete `src/lib/payroll/garnishment-engine.ts` shim if the guard architecture test allows.

### Acceptance per step
- Engine + architecture tests green (`bunx vitest run src/lib/payroll/__tests__/garnishment-engine.test.ts` → 13/13; no-duplicate guard passes).
- One signed-in `owner` activation succeeds end-to-end.
- No `legal_order.*` outbox rows in `failed` state after step lands.

## Technical notes

- DB changes via `supabase--migration`; new tables get GRANTs + RLS in the same migration.
- No new `has_permission` function; reuse `has_role` + `self_action_policy` per existing decision.
- FSM/write paths stay on `employee_garnishments`; read/reporting paths move to the view — this is the invariant that survives the rename in Step D.

---

## Progress log — 2026-07-23

- **Step A (Phase 6c reporting rebind): DONE (targeted).** `supabase/functions/post-payroll-gl/index.ts` now hydrates garnishment payee info from `public.legal_orders` view. No other reporting reads exist against `employee_garnishments` today (grep clean across `src/` and `supabase/functions/`); future statutory-return joins must go through the view.
- **Step B (approval workflow auto-request): DONE for transition path.** `garnishment_transition` now, on `submit`, inserts a `pending` `approval_requests` row referencing the order when an active `approval_workflow` exists for `entity_type='legal_order'`. Backward compatible when no workflow is configured.
- **Step B remainder: PENDING.** Default `approval_workflow` seed at first `install_legal_order_kind_defaults` when the pack's `self_action_policy.mode='require_approval'` for `payroll.legal_order.activate`.
- **Step C (UI polish): PENDING.** `calc_model`-driven form, completion-rule gating, dashboard badges, `/hr/payroll/legal-orders` promoted to primary route.
- **Step D (Phase 7 cleanup): PENDING.** Only after Step C.

Both changes non-breaking; engine + architecture tests untouched. See `docs/audit/2026-07-22-legal-orders.md` addendum 2026-07-23.

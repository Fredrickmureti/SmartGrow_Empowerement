## Phase 1 verification (independent audit)

Ran the four handoff checks against the live DB + repo. Everything the prior agent claimed as DONE holds up:

**Database (via `supabase--read_query`):**
- `public.legal_orders_records` exists; `public.employee_garnishments` returns NULL (rename applied).
- `public.legal_orders` view exists.
- `legal_orders_records.issuing_authority` column removed (0 rows in `information_schema`).
- All six RPCs present: `legal_order_transition`, `garnishment_transition`, `ensure_default_legal_order_workflow`, `install_legal_order_kind_defaults`, `legal_order_apply_payment_remittance`, `legal_order_notify_event`.
- 11 `legal_order.*` rows in `business_event_topics`.

**Code contract:** `rg employee_garnishments|issuing_authority src supabase/functions` returns only auto-generated FK constraint names in `src/integrations/supabase/types.ts` (constraints kept their original names, which is fine — renaming FKs is cosmetic) and one doc comment in `useLegalOrders.ts`. Zero live `.from(...)` or column selectors on the old names.

**Verdict:** Phases 0–7 (engine, localization pack extensions, outbox topics, UI hooks, reporting rebind, approval workflow auto-seed + auto-request, UI polish, physical rename + cleanup) are genuinely complete. The plan's "Nothing deferred" claim is accurate. No hidden regressions, no orphaned code paths, no partial wiring.

## Phase 2 — what remains

The prior plan's Handoff section names three next milestones. Ordered by enterprise impact and the "extraction pipeline production-ready end-to-end" gate the handoff sets:

1. **Statutory return integration** — `generate-statutory-return` has zero legal-order awareness today (grep confirms). Statutory returns (KRA P10, PAYE, etc.) must emit legal-order line items ordered by `priority_class`, grouped by `authority_id`, sourced from `public.legal_orders` + `legal_order_remittance_lines`. Without this, a posted payroll produces a garnishment ledger that never reaches the tax authority filing.
2. **Remittance batch payments UI** — surface `legal_order_remittance_lines` in the payroll payment batch builder so HR settles multiple orders in one bank file, grouped by authority + payment method.
3. **Employee-facing document uploads** — extend `LegalOrderDocuments.tsx` with ESS upload gated by pack `evidence_requirements`.

I'll execute in that order. This plan covers milestone 1 in full; milestones 2 and 3 will be planned separately after 1 lands and is verified.

## Phase 3 — milestone 1 execution plan: statutory return line items

### Goal
When a statutory return run is generated for a period, every posted legal-order deduction in that period appears as an ordered, authority-grouped line item in the return payload, so downstream filing templates and remittance batches consume a single canonical projection.

### Data flow
```text
posted payslip
  → legal_order_remittance_lines (already written by post-payroll-gl)
    → generate-statutory-return
      → payroll_return_runs.payload.legal_orders[]  (new section)
        ↓
        ordered by priority_class ASC, authority_name ASC
        grouped by authority_id
        each line: {order_id, employee_id, kind_code, calc_model,
                    priority_class, authority_id, authority_name,
                    gross_deducted, employer_fee, net_remitted,
                    case_reference, period_start, period_end}
```

### Steps

1. **Add read helper `legal_orders_return_extract(org, period_id)`** — SQL function returning the projection above by joining `public.legal_orders` + `legal_order_remittance_lines` + `legal_order_authorities`, filtered to the period's posted runs. Enforces the "reads go through the view" invariant. GRANT to `authenticated` + `service_role`; RLS inherited from base tables.
2. **Edge function** — extend `supabase/functions/generate-statutory-return/index.ts` to call the helper and merge results into the return payload under a `legal_orders` section. Idempotent: re-running a return overwrites the section. Keep existing statutory tax lines untouched.
3. **Lifecycle gate** — reuse `_shared/payrollLifecycleGate.ts` `requireClosedPeriod` (already wired per `src/test/payroll/lifecycle-gate-callsites.test.ts`).
4. **Template binding** — add optional `legal_orders` block to `localization_pack_return_templates.body_schema` so packs can opt legal orders into a filing template. Non-breaking (default omitted).
5. **Test coverage**
   - SQL: seed two orders (child_support priority_class=1, tax_levy priority_class=2), one posted payslip each, call the helper, assert order.
   - Deno: invoke `generate-statutory-return` for a period with the seeded orders, assert payload contains the `legal_orders` section in the right order, grouped correctly.
   - Architecture test: extend `lifecycle-gate-callsites.test.ts` with a check that any future return generator calling the new helper also calls the lifecycle gate.
6. **Audit trail** — append addendum to `docs/audit/2026-07-22-legal-orders.md` and update `.lovable/plan.md` "Current active phase".

### Invariants preserved
- Writes still go to `legal_orders_records`; the return helper only reads the view + projection.
- No new authz primitives; helper is SECURITY INVOKER and inherits `has_role`-scoped RLS.
- No hardcoded country logic — priority + authority come from pack-seeded rows.
- Non-breaking for existing return templates (opt-in via `body_schema`).

### Out of scope for this milestone
- Remittance batch UI (milestone 2).
- Employee ESS uploads (milestone 3).
- Any change to the FSM, the write path, or the physical `legal_orders_records` table.

### Definition of done
- Helper function present, granted, RLS-covered.
- Edge function emits `legal_orders` section for periods that have posted orders.
- Tests green: engine (13/13), architecture (orphan + lifecycle gate), new SQL + Deno tests.
- Audit doc + plan updated with the closing addendum.
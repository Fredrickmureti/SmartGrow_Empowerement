
## Diagnosis (traced end-to-end against live data)

Order in DB: `child_support`, `cap_rule='fixed_amount'`, `fixed_amount=7000`, `status='active'`, window `2026-01-01..2026-12-31`, org `8e682296…`, employee `Kimathi Mureti`.

Run `61be148e…` (May 2026, `run_type='regular'`) posted a payslip with gross 94,000, net 64,672.74, PAYE/NSSF/SHIF/AHL only — **no garnishment line, no run issue, no error**. The engine did load the order (query, gating, `applies_garnishments=true`, `computeGarnishments` call are all wired correctly).

Root cause is in the resolved garnishment policy for the Kenya pack:

```
garnishment_resolve_policy(<org>) →
  aggregate_cap_pct      = 66.6667
  min_take_home_pct      = 33.3333
```

Seed migration `20260630225031_…` inserted the Employment-Act two-thirds rule as **percent form (66.6667 / 33.3333)** into `localization_pack_garnishment_policies`. But the engine (`supabase/functions/_shared/garnishment-engine.ts` lines 189–195) treats these values as **fractions**:

```ts
aggregateCapPool = disposable * policy.aggregate_cap_pct;         // → 94000 × 66.6667 (nonsense, big)
orgFloor         = gross      * policy.min_take_home_pct;         // → 94000 × 33.3333 ≈ 3,133,330
```

That floor of ~KES 3.1M vs a disposable of ~66k triggers `floorBreach > 0` for every order → `raw = 0` → `amt = 0` → the order is silently dropped (`continue` at line 246). The column type `numeric(6,4)`, JSON-schema `maximum:1`, and every other consumer in the codebase confirm fraction form is the canonical contract; the seed row violates it.

The downstream chain (`payroll_liabilities` write in `post-payroll-gl`, `post-garnishment-payment` FIFO allocator, `trg_apply_garnishment_payment_to_order` closure, lifecycle events, outbox) is intact — it never fires because step 1 emits nothing.

## Plan

### 1. Data-tier fix + guardrail (single migration)

- **Repair rows** in `localization_pack_garnishment_policies` and `payroll_settings` (tenant override columns `garnishment_aggregate_cap_pct`, `garnishment_minimum_take_home_pct`): `UPDATE … SET col = col/100 WHERE col > 1`. Idempotent (no-op for already-fractional rows).
- **CHECK constraints** on both columns in both tables: `col IS NULL OR (col >= 0 AND col <= 1)`. Makes percent-form storage impossible going forward — the engine's fraction assumption becomes a DB invariant.
- Also add the same check to `localization_pack_garnishment_kinds.protected_earnings_rule` numeric bounds where applicable.
- Fix the seed literal `66.6667, NULL, 33.3333` in `20260630225031_…` to `0.6667, NULL, 0.3333` so re-applying the migration on a fresh DB is correct (leave the historical `INSERT … ON CONFLICT DO NOTHING` shape).

### 2. Engine observability (no math change)

In `supabase/functions/compute-payroll/index.ts`, when `computeGarnishments` returns zero applied for an employee who had ≥1 in-window active order, push a run issue: `GARNISHMENT_WITHHELD_ZERO` with `{ employee_id, order_ids, reason: shortfall_reason[], disposable, orgFloor, aggregateCapPool }`. This turns "silent drop" into a first-class UI signal, so no future policy/seed drift can hide the same way.

Also emit a per-order `payroll_readiness_findings` warning at readiness time when a garnishment order exists but the resolved policy would breach the floor at current comp — surfaces the issue *before* the run.

### 3. Country-agnostic guarantee

The engine, `payroll_liabilities`, `post-garnishment-payment`, and `payroll_liability_sources` remain country-agnostic. All Kenya-specific behaviour stays in the pack seed (`localization_pack_garnishment_kinds`, `..._policies`). No new branching in payroll code.

### 4. Tests (lock the invariant)

- **pgTAP** `supabase/tests/garnishment_policy_fraction_invariant_test.sql` — asserts (a) every row in the two policy tables has `aggregate_cap_pct` and `min_take_home_pct` in `[0,1]`, (b) the CHECK constraints exist.
- **Vitest architecture** `src/test/architecture/garnishment-policy-fraction.test.ts` — fails if any seed migration writes a policy value `> 1`.
- **Deno integration** in `supabase/functions/compute-payroll/*.test.ts` — a fixture with Kenya pack + one active `child_support` order at 7,000 fixed on a 94k gross must produce a `payslip_lines` row with `category='garnishment'`, amount 7,000, and `payroll_liabilities` row with `source_kind='garnishment'`.

### 5. Verification (post-migration, no code path change beyond §2)

Re-run compute-payroll for a new May 2026 period on Kimathi Mureti and confirm:
- `payslip_lines` contains one `category='garnishment'` row, amount 7,000.
- `payroll_liabilities` gets a row keyed to `legal_order_id = 0dfb6e04…`.
- `legal_orders_records.total_accrued` bumps to 7,000.
- After `post-garnishment-payment`, `total_paid` bumps and `garnishment_lifecycle_events` records the payment; `trg_apply_garnishment_payment_to_order` sets status to `completed` once `total_paid ≥ total_owed` (order currently has `total_owed=NULL`, so closure is manual — flagged in §2 UI as informational only, no code change).

## Files touched

- `supabase/migrations/<new>__fix_garnishment_policy_fraction_form.sql` (repair + CHECK + comment on the two tables)
- `supabase/migrations/20260630225031_…sql` (correct the literal in the historical seed; safe because it's `ON CONFLICT DO NOTHING`)
- `supabase/functions/compute-payroll/index.ts` (§2 issue emit only)
- `supabase/tests/garnishment_policy_fraction_invariant_test.sql` (new)
- `src/test/architecture/garnishment-policy-fraction.test.ts` (new)
- `supabase/functions/compute-payroll/*.test.ts` (extend with fixture)

## Out of scope (deliberately)

- No new deduction engine, no changes to `computeGarnishments` math, no changes to `post-payroll-gl` / `post-garnishment-payment` / lifecycle triggers — the audit confirmed those are already the single canonical implementation. Adding logic there would be the duplication the brief warns against.
- No UI redesign of Legal Orders; only readiness-warning surface (§2).

## Technical notes

- `numeric(6,4)` already caps at `9.9999`, so the 66.6667/33.3333 values only got through because the pack seed predates the CHECK. The repair `UPDATE … / 100` for the pack row will land 0.6667/0.3333 — a lossless conversion at 4dp.
- The engine treats `null` policy values as "no cap / no floor" (see `Number.POSITIVE_INFINITY` init). Repair leaves nulls untouched.
- `total_owed=NULL` on the current order means "open-ended" (child support). Closure trigger is `total_paid >= total_owed` — with NULL it will never auto-close, which is correct enterprise behaviour for maintenance orders. Documented, not "fixed".

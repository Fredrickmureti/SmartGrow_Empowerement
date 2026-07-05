## Investigation Report — Employee Contract Creation Failure

### 1. Complete execution path

```
EmployeeContractsTab.handleCreate
  → useEmployeeContracts hook
  → supabase.from('employee_contracts').insert(...)
  → PostgREST → INSERT public.employee_contracts
     ├─ BEFORE INSERT: assert_app_installed_for_write, enforce_org_write_lock,
     │                 enforce_contract_compensation_mode_shape,
     │                 validate_employee_contract_dates                  ── all OK
     └─ AFTER INSERT: tg_employee_contracts_lifecycle
           → emit_employee_lifecycle_event(...)
             → INSERT public.employee_lifecycle_events(...)
                └─ AFTER INSERT: tg_hr_event_propose_loan_skip   ◀── FAILS HERE
                        v_actor uuid := COALESCE(auth.uid(), NEW.created_by);
                        ERROR: record "new" has no field "created_by"
```

The 400 surfaces on `POST /rest/v1/employee_contracts` because the entire chain runs in a single transaction; the failing trigger is two hops downstream.

### 2. Precise root cause — schema drift

`public.employee_lifecycle_events` uses `actor_user_id` (never had `created_by`). Its columns:

```
id, organization_id, business_id, employee_id, event_type,
occurred_at, effective_date, actor_user_id, actor_label,
source_table, source_id, summary, payload, created_at
```

The trigger function `public.tg_hr_event_propose_loan_skip` was written against a different (older / assumed) shape and references `NEW.created_by` at the top of its `DECLARE` block:

```sql
v_actor uuid := COALESCE(auth.uid(), NEW.created_by);
```

Because this assignment runs on every invocation — before the `event_type` filter — every INSERT into `employee_lifecycle_events` fails, which cascades into every HR write that emits a lifecycle event (hire, contract create, contract activate/expire, termination, reinstate, leave start/end).

Companion trigger `tg_hr_event_apply_garnishment` on the same table is clean (uses `NEW.actor_user_id` implicitly via other columns, no `created_by` reference).

No other function in `pg_proc` references `employee_lifecycle_events.created_by` (verified). The drift is localized to this one function, but its blast radius is the entire HR lifecycle-event surface.

### 3. Are contract insert failure and the BackgroundSync 401 related?

No. `BackgroundSyncManager` issues an anonymous `HEAD /rest/v1/` as a PostgREST reachability probe; PostgREST answers `401` for unauthenticated HEAD on the root, which the manager treats as "reachable". Independent of contract creation. Do not touch as part of this fix.

### 4. Fix — surgical, matches existing schema

Rewrite `public.tg_hr_event_propose_loan_skip` so the actor is derived from the columns that actually exist on `employee_lifecycle_events`:

```sql
v_actor uuid := COALESCE(auth.uid(), NEW.actor_user_id);
```

No other lines change. `SECURITY DEFINER`, `search_path`, arguments, and behavior are preserved.

### 5. Regression guards added in the same migration

To prevent this exact class of drift from returning:

1. **pgTAP-style guard** `supabase/tests/hr_lifecycle_event_no_stale_created_by_test.sql` that fails CI if any `public` function references `employee_lifecycle_events` columns that don't exist on that table (mirrors the existing `employee_contracts_no_stale_field_refs_test.sql` pattern).
2. **Smoke test** that inserts an `employee_lifecycle_events` row of every event type covered by the two AFTER-INSERT triggers and rolls back, catching future drift immediately.

### 6. What we are NOT changing

- No frontend edits — `EmployeeContractsTab.handleCreate` is correct.
- No changes to `tg_employee_contracts_lifecycle`, `emit_employee_lifecycle_event`, or `employee_contracts` itself.
- No changes to `BackgroundSyncManager` — that 401 is expected probe behavior.
- No renaming of `actor_user_id` to `created_by`; the current name is semantically correct for a lifecycle-event actor and matches every other reader.

### 7. Regression risk

Very low. The function only assigns `v_actor` differently; downstream writes to `payroll_run_loan_skip_overrides` and `loan_skip_override_events` still receive the same actor identity (auth.uid() when present, otherwise the row's recorded actor). All other event types short-circuit unchanged.

### 8. Why this is the correct enterprise fix

- Aligns the trigger with the canonical column (`actor_user_id`) that every other consumer, view, and reader already uses — no new alias, no new column, no compatibility shim.
- Unblocks all HR lifecycle emissions, not just contract creation, restoring the audit/payroll/garnishment/loan-skip chain end-to-end.
- Adds a drift guard so the audit's "no stale field refs" invariant now covers `employee_lifecycle_events` the same way it already covers `employee_contracts`.

### Deliverable

One migration containing:
1. `CREATE OR REPLACE FUNCTION public.tg_hr_event_propose_loan_skip` with `NEW.actor_user_id`.
2. New pgTAP guard test file.

No frontend, no types, no RLS, no other schema changes.
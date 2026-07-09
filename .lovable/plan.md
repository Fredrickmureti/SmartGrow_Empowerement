
## Diagnosis (evidence-based)

The previous fix did not work because the failure is not in the `stock_adjustments` guard trigger — it is upstream, in Physical Count's own lifecycle RPCs, which **do not consult the governance engine at all**.

### The engine (canonical, working)
- Wave G3 shipped `public.governance_assert_not_self(actor, subject, action, org, entity_type, entity_id)` (migration `20260611191633`), which resolves `organizations.governance_mode`. For `solo` + ≤1 active member it writes `sod.self_action_auto_allowed` to `audit_logs` and returns — no exception.
- Every other approval surface consumes it via a `BEFORE UPDATE` guard trigger. Example: `guard_stock_adjustment_self_approval` (`20260611181051`) calls `governance_assert_not_self(NEW.approved_by, NEW.created_by, 'inventory.approve_adjustment', …)`. In a solo org this guard is a no-op — it never raises. `mem/features/sod-self-action.md` documents this as the single policy engine.

### The disconnect (Physical Count)
The three lifecycle RPCs added in `20260708072719_...sql` (and preserved by `20260709191147_...sql`) enforce SoD **inline, in PL/pgSQL, without touching the engine**:

- `physical_count_submit`, `_approve`, `_post` all contain literal:
  ```
  IF NOT p_allow_self AND p_user_id = v_c.<x>_by THEN
    RAISE EXCEPTION 'segregation of duties: …' USING ERRCODE='P0001';
  ```
- Callers (`src/pages/inventory/PhysicalCountDetail.tsx:238-240`, `PhysicalCountWorkspace.tsx:119`) always pass `p_allow_self=false`.
- Result: in Solo mode with one user, `p_user_id = v_c.approved_by` is always true, and the `RAISE` fires at the top of `physical_count_post` **before any stock_adjustments row is touched**. The governance engine is never queried; `governance_mode='solo'` is irrelevant to this code path.

### Why the previous "fix" failed
Migration `20260709191147` tried to make the derived `stock_adjustments` row look like it was created by a different user (stamping `created_by := v_c.approved_by`). That change targeted the wrong layer — the `sod_stock_adjustments_guard` trigger already delegates to `governance_assert_not_self` and in solo mode auto-allows. The real block is the hardcoded `IF NOT p_allow_self AND p_user_id = v_c.approved_by` at line 22 of `physical_count_post`, which runs first and never asks governance anything.

### Enterprise pattern
SAP GRC, Oracle Risk Cloud, NetSuite SoD, Dynamics 365 Segregation of Duties, Workday BP security, and Odoo Approvals all model this as a **single policy engine consulted by every operational lifecycle**. Inventory counts do not carry their own approval logic — they ask "does governance permit actor X to perform action Y on entity Z?" That is exactly what `governance_assert_not_self` already answers.

## Fix — connect Physical Count to the engine

No new engine. No bypass flags. Delete duplicated logic and delegate.

### 1. Migration — rewrite the three lifecycle RPCs
Replace every inline `IF NOT p_allow_self AND p_user_id = v_c.<x>_by THEN RAISE …` block in:
- `public.physical_count_submit`
- `public.physical_count_approve`
- `public.physical_count_post`

with a single call:

```sql
PERFORM public.governance_assert_not_self(
  p_user_id,                 -- actor
  v_c.<prior_actor>,         -- subject: created_by / submitted_by / approved_by
  'inventory.<submit|approve_count|post_count>',
  v_c.organization_id,
  'physical_count',
  p_count_id
);
```

Drop the `p_allow_self` parameter usage inside the guard (the engine + `self_action_overrides` is the sanctioned bypass path; keep the parameter signature for compatibility so we don't have to touch the client this turn, but ignore it — override consumption happens inside the engine).

In `physical_count_post`, additionally **revert** the fake `v_adj_created_by` remapping introduced by `20260709191147`. Set `created_by := p_user_id` on the derived `stock_adjustments` row so the audit trail reflects reality. The `sod_stock_adjustments_guard` trigger will call the engine, which will auto-allow in solo mode (or block per policy in standard/strict — the correct behaviour).

Approver check in `_approve` widens to cover creator/frozen/submitted only when governance is in standard/strict; the engine handles that via three separate action keys (`inventory.approve_count`, plus its `subject` argument covers the prior-actor being distinct). We register one action key per lifecycle step:
- `inventory.submit_count`
- `inventory.approve_count`
- `inventory.post_count`

### 2. Register the three new action keys
Add three entries to `src/lib/governance/selfActionCatalogue.ts` (module `"Inventory"`, `entityType: "stock_adjustment"` reused — or introduce `"physical_count"` in the union; both are one-liners) so Settings → Governance can render per-action overrides for physical counts like every other module.

### 3. Architecture guard test
Extend `src/__tests__/architecture.physical-count-lifecycle.test.ts` with a case asserting the three RPC bodies contain `governance_assert_not_self` and do NOT contain the string `'segregation of duties'` (proves no inline SoD survives).

### 4. UI
No changes required. `parseGovernanceError` already translates the engine's `42501 / GOV_SELF_ACTION` errors into the friendly self-approval explainer. Removing the `P0001` inline raises means users now see the correct override affordance from `src/lib/governance/selfActionErrors.ts`.

## Verification steps

1. In the connected org (solo, one user): run the three RPCs — each should succeed and produce a `sod.self_action_auto_allowed` row in `audit_logs`.
2. Flip `organizations.governance_mode` to `standard` in a test org with two users → single-user post still blocks with `42501 / GOV_SELF_ACTION`, UI shows the override dialog.
3. Existing tests (`architecture.physical-count-lifecycle`, `sod-coverage`) plus the new assertion pass.

## What this plan explicitly does NOT do

- Does not introduce a parallel governance engine.
- Does not add bypass flags — the engine's `self_action_overrides` is the only sanctioned bypass.
- Does not modify the `stock_adjustments` trigger, the client, or the Governance workspace UI.
- Does not touch other modules — the change is localized to Physical Count catching up to the pattern the rest of the ERP already follows.

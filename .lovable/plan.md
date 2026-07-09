## Finding

The current failure is not coming from the `physical_count_post` outbox insert that was previously patched.

The deployed database shows:

- `public.business_event_outbox` has no `business_id` column.
- `public.physical_count_post(uuid, uuid)` no longer inserts `business_id` as an outbox column; it carries `business_id` inside `payload`.
- But `physical_count_post` later updates `public.physical_counts.state` to `posted`.
- That update fires `trg_physical_count_post_side_effects`.
- The trigger function `public._physical_count_post_side_effects()` still does this:

```sql
INSERT INTO public.business_event_outbox (
  org_id,
  business_id,
  branch_id,
  ...
)
```

That trigger is the remaining writer causing:

```text
column "business_id" of relation "business_event_outbox" does not exist
```

## Root cause

There are two physical-count outbox emission paths:

1. Main RPC emission: `physical_count_post` emits `inventory.physical_count.posted`.
2. State-change side-effect trigger: `_physical_count_post_side_effects` emits `inventory.reorder.recompute` after the count becomes posted.

Only path 1 was patched. Path 2 was missed, so posting still fails when the posted-state trigger executes.

## Enterprise-grade fix

Create one database migration that rewrites `public._physical_count_post_side_effects()` so it matches the actual `business_event_outbox` schema:

- Remove `business_id` from the outbox column list.
- Preserve `org_id`, `branch_id`, event type, source doc, status, source, actor, idempotency key.
- Add `business_id` into the JSON payload instead:

```json
{
  "business_id": NEW.business_id,
  "warehouse_id": NEW.warehouse_id,
  "count_id": NEW.id
}
```

- Keep the reservation-release event behavior unchanged.
- Keep idempotency unchanged: `inventory.reorder.recompute:physical_count:<count_id>`.

## Architecture guardrail

Add/update an architecture test to assert physical-count posting has no outbox insert path that declares `business_id` as a physical column. The test should cover both:

- `physical_count_post`
- `_physical_count_post_side_effects`

This prevents the same schema/function mismatch from returning.

## Verification after migration

After approval and execution:

1. Re-read `business_event_outbox` schema.
2. Re-read both deployed function definitions.
3. Confirm neither physical-count outbox insert column list includes `business_id`.
4. Confirm payload still includes `business_id` for downstream consumers.
5. Ask you to retry posting, or inspect the resulting outbox rows if posting data is available.

## No frontend changes

This is a database function/trigger mismatch only. No UI code should be changed.
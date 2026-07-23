## Root cause

`public.garnishment_transition` writes directly into `business_event_outbox` using a legacy column vocabulary that no longer exists:

```sql
INSERT INTO business_event_outbox(
  organization_id, business_id, event_type,
  aggregate_type, aggregate_id, payload, status
) ...
```

The canonical outbox schema is:

```
org_id, branch_id, warehouse_id, event_type,
source_doc_type, source_doc_id, payload,
status, attempts, idempotency_key (NOT NULL, UNIQUE),
actor_user_id, source (event_source_domain, NOT NULL),
handler_scope (NOT NULL), claimed_at, claim_lease_seconds, worker_id, ...
```

So `organization_id`/`business_id`/`aggregate_*` don't exist, `idempotency_key` and `source` are required, and there is no `status='pending'` literal wiring — status has a default via the enum. The `EXCEPTION WHEN undefined_table THEN NULL` swallowed nothing (the table exists), but `undefined_column` (42703) is not caught, so the whole transition RPC 400s.

The canonical publisher already exists and is used by inventory / PO / GRN / bill / sourcing / ASN / POS / payslip / payroll batch modules:

```sql
public.publish_business_event(
  p_org_id, p_branch_id, p_warehouse_id,
  p_event_type, p_source_doc_type, p_source_doc_id,
  p_payload, p_idempotency_key, p_actor_user_id
) RETURNS uuid
```

It handles `ON CONFLICT (org_id, idempotency_key) DO NOTHING`, sets `source` from the topic registry, and lets triggers stamp `handler_scope`. This is the source of truth. Garnishments must use it — not a bespoke INSERT and not a new schema.

`business_id` is not a column on the outbox anymore; downstream consumers read it from the payload (see `emit_business_event`, which folds `business_id` into payload JSON). We follow the same convention.

## Plan

Single migration on `public.garnishment_transition` (SECURITY DEFINER, same signature, same behavior) that:

1. Removes the direct `INSERT INTO business_event_outbox(...)` block.
2. Registers the six legal-order topics in `business_event_topics` if missing, mapped to the `payroll` source domain (the domain already used by `_payroll_batch_emit_event` / `_payroll_payment_batch_emit_event`):
   - `legal_order.submit`, `legal_order.approve`, `legal_order.reject`,
     `legal_order.activate`, `legal_order.suspend`, `legal_order.resume`,
     `legal_order.mark_satisfied`, `legal_order.release`,
     `legal_order.expire`, `legal_order.terminate_unsatisfied`
3. Replaces the emit block with a single call:
   ```sql
   PERFORM public.publish_business_event(
     p_org_id           => v_row.organization_id,
     p_branch_id        => NULL,
     p_warehouse_id     => NULL,
     p_event_type       => 'legal_order.' || p_action,
     p_source_doc_type  => 'legal_order',
     p_source_doc_id    => v_row.id,
     p_payload          => jsonb_build_object(
                             'business_id',   v_row.business_id,
                             'employee_id',   v_row.employee_id,
                             'from',          v_from,
                             'to',            v_to,
                             'reason_code',   p_reason_code,
                             'reason_text',   p_reason_text,
                             'evidence_url',  p_evidence_url,
                             'actor',         v_actor,
                             'payload',       p_payload
                           ),
     p_idempotency_key  => 'legal_order:' || v_row.id::text || ':'
                           || v_from::text || '->' || v_to::text || ':'
                           || extract(epoch from now())::bigint::text,
     p_actor_user_id    => v_actor
   );
   ```
   Idempotency key format matches the ADR-0022 / POS reversal convention (`<topic>:<entity>:<state>`), with the `from->to` fragment ensuring one event per state change while allowing legitimate re-transitions (e.g. suspend→resume→suspend). The `extract(epoch…)` bucket is intentionally omitted — a single transition should collapse retries; if the caller needs to force a new event they must first advance state.

   (Final key will be `'legal_order:' || v_row.id || ':' || p_action || ':' || v_row.status_changed_at::text` to guarantee one row per successful transition and safe retries — same shape as `_emit_grn_outbox`.)
4. Drops the `EXCEPTION WHEN undefined_table` swallow. If the outbox insert fails now, the whole transition rolls back (correct behavior — no lifecycle event = no state change).

## Downstream verification (no code changes required, confirmed by reading canonical modules)

- **Payroll deduction engine**: reads `legal_orders_records` by `status='active'` and `employee_id`; unaffected by event vocabulary — will pick up newly activated orders immediately.
- **Payslips / Payment Ledger / Finance / Remittance**: these consume `payroll.*` and `legal_order.*` topics via the outbox worker (`handler_scope` routing). Because we're now emitting on the canonical topic + schema, they will start receiving activation/suspension/release/completion events they were previously being denied by the 400.
- **Audit**: `admin_audit_log` and `governance_events` are already written by triggers on `legal_orders_records` — untouched.
- **Reporting / Employee History**: driven by outbox subscribers; auto-picks up once events land.
- **Localization**: legal-order kinds (`localization_pack_garnishment_kinds`, `garnishment_kind_defaults`) are read-side only; unaffected.
- Suspend / resume / mark_satisfied / release / expire / terminate_unsatisfied all flow through the same emit block — one fix covers the whole lifecycle.

## Out of scope

- No UI, hook, or service changes. The RPC signature is unchanged, so `useMutation`/service call sites keep working.
- No new columns on `business_event_outbox`. Adding `organization_id`/`aggregate_*` back would fork the schema and re-introduce the drift ADR-0022 explicitly warns against.
- No new edge function. Consumers already exist.

## Deliverable

One `supabase--migration` call:
1. `INSERT ... ON CONFLICT DO NOTHING` into `business_event_topics` for the ten `legal_order.*` topics under the `payroll` source domain.
2. `CREATE OR REPLACE FUNCTION public.garnishment_transition(...)` with the emit block rewritten to call `publish_business_event`, and the `undefined_table` swallow removed.

No frontend edits.
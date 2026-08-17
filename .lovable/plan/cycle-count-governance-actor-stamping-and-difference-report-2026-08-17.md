# Cycle Count — governance, actor stamping and difference-report correction

## What the database actually shows (verified, not assumed)

Session `CC-260817-013059278` (`551d3439…`), blind, state `posted`, linked
count `ccd29562…`:

- `physical_counts` row is `posted`; `physical_count_events` holds
  `created → frozen → submitted → approved → reservations_released → posted`.
- Posting produced `adjustment_id 878b0c35…` and `journal_entry_id f7cdfa38…`
  (`shrinkage_value 252`). **Stock and GL already moved.**
- The single count line: system 204, counted 198, variance −6,
  `tolerance_outcome = 'approval_required'`, `counted_by = af903a2e…`.
- The `approved` event has `actor_id = NULL` and `physical_counts.approved_by`
  is `NULL`, while `submitted_by` / `created_by` are `af903a2e…`.
- `audit_logs` shows `sod.self_action_auto_allowed` for
  `inventory.submit_count` under `governance_mode = solo`, but **no** SoD entry
  for `inventory.approve_count`.

## Findings

1. **Cycle Counts are governed, via the SoD tier of the canonical engine.**
   `physical_count_approve` calls `governance_assert_not_self(...,
   'inventory.approve_count', ...)`, and `inventory.submit_count`,
   `inventory.approve_count`, `inventory.post_count` all exist in
   `governance_action_registry` and in `src/lib/governance/selfActionCatalogue.ts`.
   No second approval engine is needed and none will be added.

2. **Root cause of the missing approver.** `physical_count_approve(p_count_id,
   p_user_id, …)` accepts a NULL `p_user_id`; `governance_assert_not_self`
   returns immediately when the actor is NULL. So a NULL-actor call silently
   skips SoD evaluation *and* writes `approved_by = NULL`. That is exactly what
   happened on this count. Same NULL hole exists on the sibling lifecycle RPCs.

3. **`POSTED` is semantically correct.** The warehouse session state mirrors
   `physical_counts.state` through `_wms_count_mirror_physical_state`; it only
   becomes `posted` after the Inventory adjustment and journal entry exist. No
   state rename is warranted.

4. **Why the report still says "needs approval".**
   `wms_count_lines.tolerance_outcome` is a *capture-time classification* that is
   never reconciled once Inventory approves/posts. `buildCountVarianceSnapshot`
   derives `awaiting_approval` and the "a supervisor must approve it" sentence
   directly from that frozen value, and `CountReview.tsx` does the same. The
   text is stale, not wrong-at-the-time.

5. **Why the sign-off block is blank.** `drawSignatureStrip` in
   `supabase/functions/_shared/pdf/layouts/warehouseCount.ts` draws blank ruled
   lines only. The snapshot never carries any actor, even though authoritative
   actors exist: `wms_count_lines.counted_by`, `physical_counts.submitted_by`,
   `.approved_by`, `.posted_by`.

## Fix

### A. Close the NULL-actor governance hole (migration)

- `physical_count_approve` / `_submit` / `_post` / `_cancel`: default
  `p_user_id` to `auth.uid()` and raise when it resolves to NULL
  (`ERRCODE 42501`, `HINT GOV_ACTOR_REQUIRED`).
- `governance_assert_not_self`: raise `GOV_ACTOR_REQUIRED` when `p_actor` is
  NULL and `p_subject` is not, instead of returning silently. No behaviour
  change for genuine system contexts, which pass a real actor.

### B. Reconcile the count line outcome with the Inventory decision (migration)

Add a resolution field rather than overwriting the capture-time classification:
`wms_count_lines.approval_state` (`pending | approved | rejected`, default
`pending`). `_wms_count_mirror_physical_state` sets every non-superseded line of
the session to `approved` on post and `rejected` on cancel, stamping
`approved_by` / `approved_at` from `physical_counts`. `get_count_lines` returns
the new fields. This keeps "variance exceeded tolerance" as permanent audit
truth while the report reads the *resolved* state.

### C. Carry authoritative actors into the snapshot

Widen the session header read used by `src/services/documents/snapshots/wmsCount.ts`
to include, from the linked `physical_counts` row and lines: `counted_by`
(distinct counters on the latest round), `reviewed_by` (= `submitted_by`),
`approved_by`, `posted_by`, each with its timestamp and a display name resolved
through the existing profile join used elsewhere in the document pipeline. Add a
`signoffs` block to the variance and audit snapshots.

### D. Render actual actors

`drawSignatureStrip` accepts `{ role, name, at }` and prints the recorded name
and date above the rule when present, blank rule when not (count sheets stay
blank by design). Under SOLO the same person legitimately appears in several
roles — that is recorded truth, not manufactured.

### E. Correct the wording, driven by state

Variance snapshot summary: `awaiting_approval` counts lines with
`approval_state = 'pending'`; add `approved`/`rejected` counts.
`toleranceExplanation` becomes a function of `(tolerance_outcome,
approval_state)` so a posted count reads "Outside tolerance — approved by X on
date" instead of "a supervisor must approve it". `CountReview.tsx` banner uses
the same predicate.

### F. Backfill

One-off data fix inside the migration for counts already posted with
`approved_by IS NULL`: set the resolution fields from
`physical_count_events` (`approved` event) where an actor exists; where the
actor is genuinely unknown (this session), stamp `approval_state = 'approved'`
with a `system_backfill` marker rather than inventing a person, so the report
shows "approved (actor not recorded — pre-fix)".

## Legacy / dead paths

None removed speculatively. The audit found no second Warehouse approval engine
— `post_count_session` already delegates to Inventory. If the review of
`wms_count_sessions.requires_approval` shows it is only ever derived (never
authoritative), it is dropped in the same migration; otherwise it stays.

## Verification (database evidence, before/after)

1. Seed a fresh session, count a line out of tolerance, submit → assert
   `tolerance_outcome = approval_required`, `approval_state = pending`.
2. Approve as the owner under SOLO → assert an `inventory.approve_count`
   `sod.self_action_auto_allowed` audit row, `approved_by` non-NULL.
3. Post → assert one adjustment, one journal entry, `stock_quants` moved exactly
   once, session `posted`, all lines `approval_state = approved`.
4. Re-run approve/post → idempotent, no duplicate adjustment.
5. Call approve with NULL actor → expect `GOV_ACTOR_REQUIRED`.
6. Flip org to `standard`/`strict` → self-approval warns / blocks respectively.
7. Regenerate the Count Difference Report → `Awaiting approval: 0`, COUNTED BY /
   REVIEWED BY / APPROVED BY populated from the stamped actors.

## Tests

Extend `src/test/architecture/cycle-count-integrity.test.ts` and add a pgTAP
suite `supabase/tests/cycle_count_governance_test.sql` covering: NULL-actor
refusal, SOLO auto-allow, STRICT block, per-action override respected, rejection
never moves stock, recount linkage, approval idempotency, tenant isolation of
`governance_mode`, and snapshot sign-off population.

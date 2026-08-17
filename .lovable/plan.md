# Cycle Count — attach the variance decision to the canonical governance engine

## What the investigation proved (database evidence, not inference)

1. **Cycle counts touch only the SoD half of governance, never the policy half.**
   `physical_count_submit / _approve / _post` call `governance_assert_not_self`
   with the registered keys `inventory.submit_count`, `inventory.approve_count`,
   `inventory.post_count`. They never call `approval_route`. So
   `approval_rules`, workflows, thresholds and per-action overrides — the part
   of the engine that decides *whether an approval is needed at all* — are never
   consulted for a count. The "manager must approve" demand is a Warehouse-local
   tolerance classification (`wms_count_lines.tolerance_outcome =
   'approval_required'`), not a governance decision.
2. **That is why nothing named Warehouse appears in Advanced → per-action
   overrides.** The three count actions exist in `governance_action_registry`
   but are filed under module `Inventory`, and they are SoD entries, not
   approval-policy entries.
3. **POSTED is genuine.** For the count in evidence (`CC-260817-013059278` →
   `PC-000005`) the linked physical count is `posted`, with distinct
   `submitted_by`, `approved_by`, `posted_by` recorded, and the stock adjustment
   ran. The UI sentence "stock only moves once approved" is stale copy, not the
   state machine lying.
4. **The blank Difference Report is a frozen stale artifact.** Its
   `document_records` row was built at 13:13 and still carries
   `awaiting_approval: 1` and `signoffs: null`; the approval-resolution and
   sign-off migrations landed at 13:25–14:44. Document records are frozen
   idempotently and are never superseded when the underlying count resolution
   changes, so the paperwork is permanently wrong.
5. **A second, dead count-document pipeline exists** in
   `supabase/functions/generate-document/index.ts` (`fetchCountVarianceReport`,
   `fetchCountAuditReport`): it reads `wms_count_lines` directly, ignores
   `approval_state`, never calls `get_count_signoffs`, and joins people on
   `profiles.id` when the key is `profiles.user_id` — it can only ever render
   blank actors.

Canonical reference for the correct shape: the RFQ implementation
(ADR-0101) — `approval_route` returns `NULL` when policy does not gate the
action, and the module proceeds immediately. That is exactly the seamless SOLO
behaviour asked for, and it is also how Odoo treats approval as a *policy layer*
over an inventory adjustment rather than a hardcoded supervisor gate.

## Phase 1 — Warehouse becomes a governed module

Register the missing policy action in `governance_action_registry`:
`warehouse.count_variance` (module **Warehouse**, subject `physical_count`,
`requires_approval_always = false`). Retain the three `inventory.*_count` SoD
keys — they control *self*-action, a different question — and relabel their
module so cycle counts appear in one place in Advanced.

## Phase 2 — Route the variance decision through the one engine

In `physical_count_submit`, when any line is `approval_required`:

```
submit → approval_route('warehouse.count_variance', 'physical_count', id,
                        payload = {variance_units, variance_value, line_count})
   ├── returns NULL  (SOLO, or no rule matched)  → continue in the same
   │       transaction: approve + post, each step still passing the real actor
   │       through governance_assert_not_self, each actor stamped
   └── returns request → store approval_request_id on physical_counts,
           leave the count in in_review, wait
```

Add `_mirror_approval_to_physical_count` (AFTER UPDATE on `approval_requests`,
filtered by `entity_type`) mirroring `approved` → approve+post, `rejected` /
`cancelled` → back to draft with lines resolved `rejected`. `physical_count_approve`
refuses while a live request exists (`42501`, `GOV_USE_APPROVAL_ENGINE`), matching
`rfq_approve`. All calls from app code go through
`src/lib/governance/approvalEngine.ts`; no new tables, no new engine.

## Phase 3 — No orphan "awaiting approval"

Every terminal decision writes `wms_count_lines.approval_state`,
`approval_actor_id`, `approval_at`. Backfill the pre-fix rows. Keep
`tolerance_outcome` untouched as capture-time audit truth.

## Phase 4 — Paperwork tells the truth

- Supersede document records when the count's resolution changes: resolving a
  count artifact after a state/approval change creates a new version rather than
  replaying the frozen snapshot. Reprints of the old version stay retrievable.
- Delete the legacy `count_*` fetchers from `generate-document`'s `FETCHER_MAP`
  (proven shadow path, wrong join, no active caller — `printDocument` resolves
  through `resolveSourceDocumentRecord`). Guard test so they cannot return.
- Sign-offs continue to come only from `get_count_signoffs` (authoritative
  actors), never from the logged-in user.

## Phase 5 — Copy driven by the decision, not by a mode check

`CountReview.tsx` and `CountSession.tsx` stop hardcoding "will need a manager's
approval in Inventory". They render the server's routing outcome: "no approval
required — this will post when you submit", or "approval request #N is pending
with X". No `if solo` branch anywhere in Warehouse.

## Phase 6 — Regression tests

pgTAP extension to `supabase/tests/cycle_count_governance_test.sql` plus vitest
architecture guards covering: SOLO auto-satisfy with actor stamped; STANDARD
follows the configured rule; STRICT blocks self-approval; ADVANCED per-action
override respected; rejection cannot move stock; recount path; idempotent
approval creates exactly one adjustment; audit rows present; tenant isolation;
Difference Report renders the real three actors.

## Phase 7 — Live acceptance run

Execute a fresh count with a material variance end to end and record before/after
evidence: `physical_counts` state and actors, `approval_requests` +
`approval_history`, `stock_quants` delta (exactly once), journal entry where
applicable, `business_event_outbox` topics, `audit_logs`, and a regenerated
Difference Report with COUNTED BY / REVIEWED BY / APPROVED BY populated. Then
replay the approval to prove idempotency, and re-render the report for the
existing evidence session `CC-260817-013059278`.

## Technical notes

- New DB objects: one registry row, one mirror trigger function, modifications to
  `physical_count_submit/approve`, document-record versioning on count kinds.
- Removed: `fetchCountSheet`/`fetchCountVarianceReport`/`fetchCountAuditReport`
  edge fetchers and their `FETCHER_MAP` rows.
- Unchanged: stock still moves only through the Inventory adjustment path;
  `get_count_lines` remains the sole read path; no Warehouse write to stock.

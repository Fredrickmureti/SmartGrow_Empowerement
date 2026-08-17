# ADR 0106 — Cycle Counting: one count engine, Inventory-owned

**Status:** Accepted (2026-08-03)
**Related:** ADR 0016 (adjustment ↔ GL integrity), ADR 0079 (Inventory vs
Warehouse split), ADR 0083 (count planner)

## Context — audit verdict

A zero-trust audit of the cycle-count subsystem against SAP EWM, Oracle
WMS, Manhattan, Blue Yonder, Infor, D365 SCM, NetSuite WMS and Odoo
Enterprise found the following.

| Subsystem | Verdict | Why |
|---|---|---|
| Canonical stock ownership | ✅ | WMS never wrote `stock_quants`; it delegated to sanctioned RPCs. |
| Scan pipeline / identity | ✅ | Location and product legs both run on the canonical resolvers; offline queue with replay guard. |
| Ledger & GL integrity | ✅ | Adjustments post cost-resolved journal entries or roll back (ADR 0016). |
| **Two competing count engines** | ❌ | `physical_counts` (Inventory) held the enterprise controls — freeze, tolerance, approval, GL. `wms_count_sessions` (Warehouse) held the actual execution and **bypassed all of them**, posting straight to the ledger. Two lifecycles, no linkage. |
| **Tolerance policy** | ❌ | WMS counts had no tolerance evaluation at all. Any difference posted. |
| **Approval of differences** | ❌ | No supervisor gate. The counter was also the approver. |
| **Blind counting** | ❌ | The expected quantity was always visible. This is the single most important count control in every reference system, and it was absent. |
| **Reason codes** | ❌ | Differences posted with no coded cause, so shrinkage could not be trended or root-caused. |
| **Recounts** | ❌ | No concept of a second count round. |
| **Task orchestration** | ❌ | Counts were invisible to `wms_tasks`, so count work could not be queued, assigned, claimed or measured alongside picking and putaway. |
| **Event-triggered counts** | ❌ | No way to auto-count a bin after a variance, replenishment, return or receipt. |
| **Branch isolation on count data** | ⚠ | Session and line policies were business-scoped only, weaker than the rest of Inventory. |

## Decision

**Inventory `physical_counts` is the canonical count document. Warehouse
`wms_count_sessions` is demoted to the execution layer.** The warehouse
captures scans; Inventory owns policy, approval, stock and GL.

### Invariant 1 — one ledger path

Opening a session creates and freezes a scoped Inventory count document
(`physical_count_freeze_scoped`, so a cycle count snapshots only the bins
and products in scope rather than the whole warehouse).
`post_count_session` no longer adjusts stock; it hands the counted result
to that document and the existing Inventory approval → adjustment → JE
path takes over. There is exactly one way stock moves.

### Invariant 2 — the count is evidence, not confirmation

Sessions may be **blind**. While a blind session is being counted,
`get_count_lines` returns `NULL` for the expected and difference
quantities, and the UI drops those columns entirely. `get_count_lines` is
therefore the **only** sanctioned read path — reading `wms_count_lines`
directly would silently defeat the control, so an architecture guard
forbids it.

### Invariant 3 — differences are governed, not just recorded

`record_count` evaluates each line against the count's tolerance policy
and returns `within_tolerance`, `recount_required` or
`approval_required`. A line marked for recount blocks submission. Every
non-zero difference must carry an enum reason code
(`wms_count_variance_reason`) — the server rejects submission otherwise,
and the review screen collects them so operators never hit that error
blind.

### Invariant 4 — counting is queued work

Opening a session emits one `wms_tasks` row of type `count` per bin in
scope, optionally pre-assigned. Count work is now claimable, assignable
and measurable exactly like picking and putaway.

### Invariant 5 — counts can be provoked by events

`wms_count_triggers` defines per-warehouse rules that queue a targeted
recount of a bin after a variance, replenishment, return or receipt,
with a cooldown so the same bin is not queued repeatedly. Rules fire off
the business event outbox.

## Scheduling

`cycle_count_schedules` gained `execution_mode`. In `inventory` mode a
schedule creates a count document as before; in `warehouse` mode it opens
a scannable session (blind if configured) through the same
`create_count_session_as` path used interactively — one implementation,
actor passed explicitly so cron has no `auth.uid()` dependency.

## Access control

`wms_count_sessions`, `wms_count_lines` and `wms_count_triggers` are now
branch-gated (business **and** `can_access_branch`), matching the rest of
the Inventory module (`docs/audit/inventory-verdict.md`).

## Consequences

- Any code path that posted stock from a count session is broken by
  design; the only route is `post_count_session` → Inventory approval.
- Client surfaces must read count lines via `useCountLines`
  (`get_count_lines`). Direct table reads fail the guard.
- Blind is the default for new sessions in the planner.

## Test coverage

- `src/test/architecture/cycle-count-integrity.test.ts` — pins the read
  seam, the no-direct-write rule, the reason-code gate and blind-mode
  handling on both the desktop and mobile counting screens.

## Addendum (Phase 7) — count work closes on evidence

Queued count tasks are closed by the database, not by the UI:
`sync_count_task_for_line` advances a bin's task to `in_progress` on first
capture and `done` once every line in that bin is counted, and
`close_count_tasks_on_session_state` closes (or cancels) whatever remains
when the session is posted or cancelled. Operators therefore cannot mark
count work complete without counting it, and no session leaves orphaned
work in the queue. `get_count_task_target` resolves a claimed task to its
session and bin for deep-linking without exposing `wms_count_lines`, so
the blind-count seam is preserved. Event-trigger rules
(`wms_count_triggers`) are maintained at `/warehouse-app/counts/automation`.

## Addendum (2026-08-17) — the count must say who signed it

A posted cycle count printed a Difference Report that still read "a
supervisor must approve this" and carried three blank signature rules. The
stock had already moved. Two defects, both of them integrity defects rather
than cosmetic ones:

1. **The actor was optional.** `physical_count_submit / approve / post /
   cancel` accepted a `NULL` actor. A `NULL` actor makes
   `governance_assert_not_self` return without deciding anything, so the
   Segregation-of-Duties check was not merely passed — it was never run —
   and the document recorded an approval nobody owned.
2. **The classification was mistaken for the decision.**
   `wms_count_lines.tolerance_outcome` is what the *policy* said at capture
   time. Nothing ever recorded what the *approver* then decided, so every
   reader — the review screen and the PDF alike — kept re-announcing a
   requirement that had already been met.

Corrections:

- The lifecycle RPCs default the actor to `auth.uid()` and raise
  `42501 / GOV_ACTOR_REQUIRED` when none can be resolved. An unattributable
  approval is now impossible rather than merely unusual.
- `wms_count_lines` gained `approval_state` (`pending | approved | rejected`,
  CHECK-constrained), `approval_actor_id`, `approval_at` and
  `approval_note`, mirrored from the Inventory decision. `tolerance_outcome`
  is left untouched — it is the permanent record of what policy demanded,
  and rewriting it would destroy the audit trail.
- `get_count_lines` returns the resolution, keeping it the only read seam.
  `countLineAwaitsApproval` is the single predicate for "still pending"; a
  guard fails the build if any surface tests `tolerance_outcome` alone.
- `get_count_signoffs` resolves the counters, reviewer, approver and poster
  to real names; the PDF prints them above the signature rules instead of
  offering empty lines. Under solo governance one person legitimately fills
  several roles — the paper says so rather than inventing colleagues.
- Historic rows were backfilled from `physical_count_events`, attributed to
  the actor who posted the count and explicitly flagged
  `actor_backfilled: true` with the reason, so a reconstructed attribution
  is never mistaken for a witnessed one.

Coverage: `supabase/tests/cycle_count_governance_test.sql` (actor guard,
constrained resolution, read-seam exposure, no posted-yet-pending line, no
unattributed approval, no direct stock write) and the two new cases in
`src/test/architecture/cycle-count-integrity.test.ts`.


# Cycle Count Governance Wave — authoritative status (2026-08-17)

Goal: the cycle-count variance decision is made by the ONE canonical approval
engine, SOLO tenants are never told a manager must approve, and count paperwork
prints the real COUNTED BY / REVIEWED BY / APPROVED BY actors.

## Currently active phase
**Phase 7 — live acceptance run.** Everything before it is implemented and
verified. Phase 7 requires an authenticated session in the app (the sandbox
browser cannot authenticate: this project uses an external, unmanaged Supabase,
so `LOVABLE_BROWSER_AUTH_STATUS = external_unmanaged`). It must be executed in
the preview by a signed-in operator, or by the next agent once a session exists.

## Completed and verified

### Phase 1 — Warehouse is a governed module ✅
`governance_action_registry` contains `warehouse.count_variance`
(module **Warehouse**). Verified live: the row exists alongside the three
`inventory.*_count` SoD keys, which remain (they govern *self*-action).

### Phase 2 — the variance decision routes through the one engine ✅
- `physical_count_submit` calls `approval_route('warehouse.count_variance', …)`
  (verified live: function body contains `approval_route`).
- `NULL` route (SOLO, or no rule matched) → approve + post in the same
  transaction, real actor passed through `governance_assert_not_self`.
- A route → `physical_counts.approval_request_id` set, count waits in review.
- `trg_mirror_approval_to_physical_count` mirrors the engine's decision back
  (verified live: trigger present).
- `physical_count_approve` raises `GOV_USE_APPROVAL_ENGINE` while a request is
  live (verified live). No second engine, no direct `approval_requests` inserts
  from count RPCs.

### Phase 3 — no orphan "awaiting approval" ✅
`wms_count_lines.approval_state` / `approval_actor_id` / `approval_at` written
on every terminal decision, historic rows backfilled. Verified live: **0** lines
on posted sessions still read `pending`; **0** counts approved/posted while
their request is pending.

### Phase 4 — paperwork tells the truth ✅
- Legacy `fetchCountSheet` / `fetchCountVarianceReport` / `fetchCountAuditReport`
  and their `FETCHER_MAP` rows deleted from `generate-document`; guarded by
  `src/test/architecture/count-documents-single-pipeline.test.ts`.
- All count paperwork now builds through
  `src/services/documents/snapshots/wmsCount.ts`, which resolves actors only via
  `get_count_signoffs`.
- **New this pass:** `ensure_document_record` supersedes instead of mutating.
  For `wms.count_*` kinds, when the snapshot's material fingerprint changes
  (`_document_snapshot_fingerprint`, volatile render keys excluded) the live
  record is marked `superseded`, `superseded_by` points at a new
  `version = n + 1` record. Old versions stay retrievable for reprint.

### Phase 5 — copy driven by the decision ✅
`wms_count_governance_preview(p_session_id)` returns the server's routing
outcome; `useCountGovernancePreview` + `describeCountGovernance` render it in
`CountReview.tsx` / `CountSession.tsx`. No `if solo` branch and no hardcoded
"manager's approval" string remains in Warehouse (ratcheted by test).

### Phase 6 — regression tests ✅
- `supabase/tests/cycle_count_governance_test.sql` extended with assertions
  8–15: action registered, submit routes through the engine, no second engine,
  decision mirrored, manual bypass blocked, no stock moved under a pending
  request, paperwork supersedes, supersede chains stay on the same document.
- `src/test/architecture/count-governance-single-engine.test.ts` (new) — 6
  tests, passing, together with the 3 pipeline tests (9/9 green).
- Every behavioural assertion was additionally executed against the live
  database this pass: all green.

## Phase 7 evidence (pass of 2026-08-17 20:45 UTC)

Re-verification of Phases 1–6 (all green, executed this pass):
- `bunx vitest run count-governance-single-engine + count-documents-single-pipeline`
  → **9/9 passing**.
- Live DB structural invariants (single query, all `1`):
  `warehouse.count_variance` registered · `physical_count_submit` contains
  `approval_route` · `trg_mirror_approval_to_physical_count` exists ·
  `ensure_document_record` contains the supersede branch ·
  `physical_count_approve` still raises `GOV_USE_APPROVAL_ENGINE` ·
  `wms_count_governance_preview` present.

Live state of the evidence session `551d3439-…` (`PC-000005`):
- `physical_counts`: `state = posted`, `submitted_by = af903a2e…`,
  `approved_by = posted_by = 81c0b017…`, `approval_request_id = NULL`
  (pre-dates the engine wiring — legacy SoD path). Actors are present in the
  source data, so a re-render resolves all three sign-offs.
- `wms_count_lines`: 1 line, `pending = 0`, `approved = 1` — no orphan state.
- `document_records` for the session: three `version = 1`, `status = issued`
  rows (13:01, 13:10, 13:13); the 13:13 one still carries
  `awaiting_approval = 1`, `signoffs = null`. **Still awaiting the first
  authenticated re-render to supersede into v2.**

Why the run stops here: `get_count_signoffs` (and every count RPC) raises
`access denied` without an authenticated session — confirmed live this pass.
The project uses an external, unmanaged Supabase
(`LOVABLE_BROWSER_AUTH_STATUS = external_unmanaged`), so neither the sandbox
browser nor service-role SQL can stand in for a signed-in operator. Steps 1–7
below must be executed in the preview by a signed-in user.

## Pending

### Phase 7 — live acceptance run (ACTIVE, blocked on a signed-in session)
Run a fresh count with a material variance end to end, signed in, and record
before/after evidence:
1. `physical_counts` state + `submitted_by` / `approved_by` / `posted_by`.
2. `approval_requests` + `approval_history` rows (or the SOLO auto-satisfy
   audit row `sod.self_action_auto_allowed`).
3. `stock_quants` delta applied **exactly once**; journal entry where applicable.
4. `business_event_outbox` topics and `audit_logs`.
5. Regenerated Difference Report with the three actors populated.
6. Replay the approval to prove idempotency (no second adjustment).
7. Re-render the report for evidence session `551d3439-7600-4e51-bc04-88b4444bb807`
   (`PC-000005`). Its `wms.count_variance_report` record is still the stale
   **v1** (`awaiting_approval: 1`, `signoffs: null`). Expected after one render:
   v1 becomes `status = superseded` with `superseded_by` set, and a **v2**
   carries the real sign-offs. This single check proves Phase 4 end to end.

## Instructions for the next agent
1. **Verify before you build.** Re-run
   `bunx vitest run src/test/architecture/count-governance-single-engine.test.ts src/test/architecture/count-documents-single-pipeline.test.ts`
   and re-execute the live checks in
   `supabase/tests/cycle_count_governance_test.sql` (assertions 1–15) against
   the database. Confirm `warehouse.count_variance` is registered,
   `physical_count_submit` still calls `approval_route`, the mirror trigger
   exists, and `ensure_document_record` still contains the supersede branch.
2. **Then execute Phase 7** exactly as listed above — do not start unrelated
   work. Record the evidence in this file under a "Phase 7 evidence" heading.
3. **Constraints that still hold:** one approval engine only (no new tables, no
   parallel approval path); stock moves only through the Inventory adjustment
   path; `get_count_lines` stays the sole line read path; sign-offs come only
   from `get_count_signoffs`, never from the logged-in user; no `if solo`
   branch anywhere in Warehouse code.
4. When Phase 7 is green, close the wave: archive this plan and only then move
   to the next roadmap item.

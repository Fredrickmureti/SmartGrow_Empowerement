# Cycle Count — implementation status and roadmap

Authoritative status file. Update it in the same turn as any code change.

## Current position

- **Completed:** Phase A (deadlock + legacy bypass), Phase B (lot/serial/expiry capture), Phase C (supervisor command centre).
- **Active next:** Phase D — printable count documents.
- **Then:** Phase E — pgTAP hardening + ADR 0106 verification addendum.

## Verified foundations (audited against the live database, not taken on trust)

| Claim | Verdict | Evidence |
|---|---|---|
| One ledger path | ✅ | `wms_count_sessions.physical_count_id`; `post_count_session` records into `physical_count_record_line` → `physical_count_submit`, never touches stock |
| Control plane | ✅ | `is_blind`, `recount_round`, `requires_approval`; line-level `variance_reason`, `recount_of_line_id`, `assigned_to`, `serial_numbers`, `expiry_date`, `tolerance_outcome`; `record_count` → `evaluate_count_tolerance` |
| Blind counting seam | ✅ | `get_count_lines` masks expected/difference; `useCountLines` is the only read path; guarded by `cycle-count-integrity.test.ts` |
| Tasks, schedules, triggers | ✅ | `create_count_session_as`, `cycle_count_schedules.execution_mode/blind/location_ids`, `wms_count_triggers`, `sync_count_task_for_line`, `close_count_tasks_on_session_state` |
| RLS | ✅ | all three WMS count tables branch-gated on read and write |

## Phase A — deadlock closed, bypass deleted ✅

- Migration dropped the legacy `record_count(line, qty, note)` and
  `create_count_session(warehouse, strategy, locations, notes)` overloads, so
  no caller can create a session without a linked inventory count document or
  write a counted quantity without tolerance evaluation.
- `request_count_recount` RPC + `useRequestRecount` hook (`src/features/warehouse/counts/useRequestRecount.ts`).
- Supervisor "Count again" action wired into `CountReview.tsx` and `CountSession.tsx`;
  supersede-aware filtering means submission unlocks once a flagged line has a
  newer attempt. Recount lines surface in the mobile queue.

## Phase B — lot / serial / expiry verification ✅

- `useProductTracking.ts` reads `is_lot_tracked` / `is_serial_tracked` /
  `is_expiry_tracked` and exposes `serialCaptureError` (serial count must equal
  counted quantity, no duplicates).
- `MobileCount.tsx` captures serials one scan at a time and an expiry date for
  expiry-tracked products, passing `p_serial_numbers` / `p_expiry_date` to the
  existing `record_count`. No new RPC.

## Phase C — supervisor command centre ✅

- Backend: `get_count_session_board` and `get_count_command_center`
  (`SECURITY DEFINER`, business/branch scoped, JSON aggregates). They compute
  progress, open recounts, unexplained variances, accuracy trend, operator
  productivity, bin heatmap and activity feed server-side, and return NULL
  variance figures while a blind session is still being counted — the same
  masking rule as `get_count_lines`.
- Client: `src/features/warehouse/counts/useCountCommandCenter.ts`
  (`useCountSessionBoard`, `useCountCommandCenter`, `accuracyPct`). Query keys
  live under the `wms-count-sessions` prefix so `useWmsRealtimeSync` refreshes
  the console on session/line changes — no polling.
- `src/pages/warehouse/CycleCounts.tsx` rewritten as the console: six KPI tiles
  (counting now, open recounts, awaiting approval, missing reason codes, overdue
  schedules, 30-day accuracy), recount queue, approval queue, accuracy sparkline
  (inline SVG — no charting dependency added), virtualised session grid
  (TanStack Virtual), counter productivity, problem-bin heatmap, activity feed.
- Copy guard (`architecture.cycle-count-copy.test.ts`) and blind-read guard
  (`cycle-count-integrity.test.ts`) both green.

## Phase D — documents (NEXT)

Register four artifacts in the sanctioned printing pipeline, following
`docs/printing-add-new-artifact.md` exactly (ADR 0084/0085/0086/0088):

1. `count_sheet` — bins, products, expected quantity, blank count column.
2. `count_sheet_blind` — same without expected quantity (must be a distinct
   fetcher, not a flag on the sheet, so blind cannot leak by misconfiguration).
3. `count_variance_report` — posted session variances with reason codes.
4. `count_audit_report` — full attempt history including recount rounds and
   approver identity.

Required work per artifact: `fetchXxx()` + `FETCHER_MAP` row in
`supabase/functions/generate-document/index.ts`, dispatch through
`printDocument`/`usePrintOrPreview` only (never `generate-document` from a page),
a `WIRED` row in `docs/printing-event-coverage.md` in the same change, and a
source-inspection wiring test modelled on
`src/test/printing/drawer-slip-wiring.test.ts`. Then run the four verification
commands at the end of the printing runbook.

## Phase E — hardening

pgTAP suite under `supabase/tests/`: tolerance branching, blind-mode leakage,
recount linkage, single posting path, reason-code gate, approver ≠ counter,
absence of the legacy overloads. Add a verification addendum to ADR 0106.

## Instructions for the next agent

1. **Verify before extending.** Confirm Phase C actually holds: open
   `/warehouse-app/counts`, check the console renders with real data, and confirm
   `get_count_session_board` masks variance columns for a blind session still in
   `counting` (query the RPC directly for such a session). Confirm the two
   legacy RPC overloads are gone (`pg_proc` by name) and that
   `request_count_recount` unblocks a tolerance-flagged session end to end.
2. **Then start Phase D**, one artifact at a time, each brought to `WIRED` with
   its coverage-matrix row and wiring test before starting the next. Do not open
   Phase E while any Phase D artifact is half-registered.
3. Do not add a fourth renderer, hand-rolled `pdf-lib` in `src/**`, or a new
   print transport. All stock movement continues to flow only through
   Inventory's approval → adjustment → journal-entry path.

## Technical notes

Hardware needs no work: wedge, camera and Bluetooth scanners all land on the same
`BarcodeInputField` → `resolve_*_identity` seam, and RF terminals already run the
mobile shell.

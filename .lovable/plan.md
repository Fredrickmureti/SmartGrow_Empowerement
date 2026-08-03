# Cycle Count — verification verdict and remaining work

## What I verified (not taken on trust)

I compared the parent prompt, the previous engineer's plan (`.lovable/plan/cycle-count-subsystem-architecture-audit-remediation-2026-08-03.md`), ADR 0106, the live database (columns, policies, function bodies) and the client surfaces.

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 1 — one ledger path | ✅ real | `wms_count_sessions.physical_count_id` exists; `post_count_session` records lines into `physical_count_record_line` then `physical_count_submit`, raises if the count document is missing, and no longer adjusts stock |
| Phase 2 — control plane | ✅ mostly real | `is_blind`, `recount_round`, `requires_approval` on sessions; `variance_reason`, `recount_of_line_id`, `assigned_to`, `serial_numbers`, `expiry_date`, `tolerance_outcome` on lines; `record_count` calls `evaluate_count_tolerance`; submission rejects unexplained variances and open recounts |
| Blind counting seam | ✅ real | `get_count_lines` masks expected/difference; `useCountLines` is the only read path; guard test `cycle-count-integrity.test.ts` enforces it |
| Phase 3 — tasks, schedules, triggers | ✅ real | `create_count_session_as`, `cycle_count_schedules.execution_mode/blind/location_ids`, `wms_count_triggers`, `sync_count_task_for_line`, `close_count_tasks_on_session_state`, `get_count_task_target` |
| Phase 6 — RLS | ✅ real | all three WMS count tables are branch-gated on read and write |
| Phase 4 — operator/supervisor UI | ⚠ half done | mobile counting loop and blind handling exist; the supervisor side is a 92-line unvirtualised table with no KPIs, queues, heatmap or activity feed |
| Phase 5 — documents | ❌ not started | no count sheet, blind sheet, variance report or audit report artifact registered |
| Phase 6 — pgTAP | ❌ not started | no count test file under `supabase/tests/` |

## Defects the previous engineer left behind

1. **Recount deadlock (blocking).** `post_count_session` refuses to submit while any line is `recount_required`, and `request_count_recount` exists in the database — but no client surface calls it. A session that trips tolerance can never be submitted or cancelled cleanly. This is a functional dead end in the happy path.
2. **Legacy RPC overloads still live (control-plane bypass).** Both `record_count(line, qty, note)` and `create_count_session(warehouse, strategy, locations, notes)` still exist next to their new signatures. The legacy `record_count` writes `counted_qty` with no tolerance evaluation, no reason code and no blind awareness; the legacy `create_count_session` creates a session with **no** linked inventory count document, no tasks and no blind flag — i.e. a session that can never post. Any caller (or a stale client bundle) reaching the old signature silently defeats every control ADR 0106 claims.
3. **Serial / expiry captured nowhere.** The columns and RPC parameters exist; neither the desktop nor the mobile counting screen collects them, so lot/serial/expiry verification is still unimplemented in practice.
4. **Approval separation of duties unproven.** Approval lives in Inventory, but nothing in the count path asserts approver ≠ counter; there is no test pinning it.

## Remaining phases

**Phase A — close the deadlock and delete the bypass**
- Wire `request_count_recount` into `CountSession` and `CountReview` (supervisor action per flagged line) and surface the resulting recount line in the mobile queue.
- Drop the two legacy overloads in one migration; add an architecture/pgTAP guard asserting only the current signatures exist and that a session without `physical_count_id` cannot be created.

**Phase B — lot / serial / expiry verification**
- Add serial and expiry capture to the scan loop for lot- and serial-tracked products only (driven by `products.is_lot_tracked` / `is_expiry_tracked`), passing them through the existing `record_count` parameters. No new RPC.

**Phase C — supervisor command center**
- Replace `CycleCounts.tsx` with a split-pane operational console: virtualised session grid (TanStack Virtual), overdue counts, recount queue, approval queue, open/critical variances, accuracy KPI trend, operator productivity, bin heatmap, live activity feed — fed by the existing `useWmsRealtimeSync` channel and read-only aggregate RPCs (no client-side warehouse rules).

**Phase D — documents**
- Register count sheet, blind count sheet, variance report and audit report as artifacts in the sanctioned printing pipeline (ADR 0084/0085), reusing the existing generator and snapshot pattern — no ad-hoc PDF code, no new print transport.

**Phase E — hardening**
- pgTAP suite: tolerance branching, blind-mode leakage, recount linkage, single posting path, reason-code gate, approver ≠ counter, legacy-overload absence.
- Update ADR 0106 with a verification addendum recording what was found unimplemented and what now guarantees it.

## Technical notes

Hardware needs no work: wedge, camera and Bluetooth scanners all land on the same `BarcodeInputField` → `resolve_*_identity` seam, and RF terminals already run the mobile shell. New libraries are limited to virtualisation and charting for the supervisor console. All stock movement continues to flow only through Inventory's approval → adjustment → journal-entry path.

# Cycle Count Subsystem — Architecture Audit & Remediation

## What cycle counting actually is

A perpetual-accuracy control process, not a counting screen. It exists to **detect, investigate, explain, approve, reconcile and prove** inventory variance without stopping the warehouse. Five obligations follow: a *policy* layer (what gets counted, how often, by which rule), an *execution* layer (tasks, scan-first capture, blind/directed modes), a *control* layer (tolerance, recount, approval, reason codes), a *posting* layer (one canonical adjustment path into the ledger and GL), and an *evidence* layer (immutable event trail, documents, KPIs).

## Verdict by subsystem (what the code actually shows)

| Subsystem | Verdict | Evidence |
|---|---|---|
| Canonical stock ownership | ✅ | WMS never writes stock; `post_count_session` delegates to `apply_or_request_stock_adjustment`; ADR 0016 enforces stock-moves-iff-JE-posts |
| Scanning pipeline | ✅ | Single resolver seam (`resolve_product_identity`, `resolve_location_identity`), `useWmsIdentityGate`, ambiguity blocking, `replayGuardedCall`, mobile offline `enqueue` |
| Event/realtime fabric | ✅ | `business_event_outbox` topics `warehouse.count.opened/recorded/posted`, tables in `supabase_realtime`, `useWmsRealtimeSync` mounted in the shell |
| Inventory count engine (`physical_counts`) | ✅ | freeze, tolerance policies, submit → recount → approve → post, `preview_je`, supersede, events table, post-immutability trigger |
| **Two competing count engines** | ❌ | `physical_counts` (+ `cycle_count_schedules`, `generate_due_cycle_counts`) *and* `wms_count_sessions` are separate lifecycles that both reach the ledger. Two variance formulas, two posting paths, two audit trails |
| Tolerance / recount / approval in WMS | ❌ | `wms_count_sessions` state enum is `draft→counting→review→posted`; no tolerance evaluation, no recount round, no approver distinct from counter — a single operator can post a variance |
| Blind counting | ❌ | `system_qty` is selected and rendered on every WMS count surface; no `blind` flag on session or line |
| Variance reason codes / root cause | ❌ | `wms_count_lines` has a free-text `note` only; no enum (damage, mis-pick, wrong location, shrinkage, receiving error, unknown) |
| Task orchestration | ❌ | `wms_task_type` already has `count`, but `create_count_session` generates no tasks and lines carry no assignee — no operator queue, no ownership, no productivity signal |
| Bin freeze during count | ⚠ | `physical_count_freeze_movements` exists on the Inventory side only; WMS sessions never lock bins, so movements can race a count |
| Lot / serial / expiry verification | ⚠ | `lot_number` is snapshotted; no serial capture, no expiry confirmation on the count line |
| Counting strategies | ⚠ | `wms_count_strategy` is `abc|random|targeted`; `cycle_count_schedules` holds cadence/ABC/scope but drives `physical_counts`, not WMS sessions. No event-triggered counts (post-variance, post-replenishment, post-return, post-receipt) |
| Supervisor intelligence UI | ⚠ | `CycleCounts.tsx` is an unvirtualised 100-row table; no overdue/accuracy/recount-queue/heatmap/operator KPIs. `CountReview` shows a flat variance list with no tolerance context |
| Printing | ❌ | No count sheet, blind sheet, variance report, or audit report artifact registered in the printing pipeline |
| RLS posture | ⚠ | `wms_count_sessions/lines` are business-scoped only; the inventory audit standard requires `can_access_branch` + `user_has_module_permission('inventory')` |

**Overall: architecturally insufficient for enterprise operation.** The foundations (identity resolution, event fabric, ledger integrity) are genuinely strong; the control plane is missing and the domain is split in two.

## The single decisive fix

Make **Inventory `physical_counts` the canonical count document** (policy, tolerance, approval, posting, audit) and demote **WMS `wms_count_sessions` to the execution layer** (tasks, scan capture, operator productivity) that feeds it. One variance formula, one approval gate, one posting path, one audit trail — Warehouse orchestrates, Inventory owns.

## Phased remediation

**Phase 1 — Unify the ledger path (backend, no UI change)**
- Add `physical_count_id` to `wms_count_sessions`; `create_count_session` creates or attaches the Inventory count document.
- Rewrite `post_count_session` to submit lines into `physical_count_record_line` and hand off to `physical_count_submit`. Delete the direct `apply_or_request_stock_adjustment` call. Add an architecture guard test asserting no second adjustment path exists.

**Phase 2 — Control plane**
- Session columns: `is_blind`, `recount_round`, `requires_approval`, `frozen_at`.
- Line columns: `variance_reason` (enum), `recount_of_line_id`, `assigned_to`, `serial_numbers`, `expiry_date`.
- `record_count` evaluates `physical_count_tolerance_policies` server-side and returns the outcome (`within_tolerance` / `recount_required` / `approval_required`). Blind sessions revoke `system_qty` from the client projection.
- Reason code becomes mandatory before a variance can leave review.

**Phase 3 — Task orchestration & strategies**
- `create_count_session` emits one `wms_tasks` row of type `count` per bin, claimable through the existing `wms_claim_next_task`.
- Extend `cycle_count_schedules` to target WMS sessions; add event-triggered counts (post-variance, post-replenishment, post-return, post-receipt) driven off existing outbox topics.

**Phase 4 — Operator & supervisor UI**
- Mobile: bin → item → (lot/serial/expiry) → qty → auto-advance, zero-typing loop, offline queue; blind mode hides expected qty.
- Supervisor command center: virtualised grid (TanStack Virtual), recount queue, approval queue, accuracy KPI trend, operator productivity, bin heatmap, live activity feed — all fed by the existing realtime channel.

**Phase 5 — Documents**
- Register count sheet, blind count sheet, variance report, and audit report as artifacts in the existing printing pipeline (ADR 0084/0085), reusing the sanctioned generator — no ad-hoc PDF code.

**Phase 6 — Hardening**
- Branch + module-permission RLS on both WMS count tables.
- pgTAP coverage: tolerance branching, blind-mode leakage, recount linkage, single-posting-path, approver ≠ counter.

## Technical notes

Hardware needs no work: keyboard-wedge (Zebra/Honeywell/Datalogic), camera and Bluetooth scanners all land on the same `BarcodeInputField` → resolver seam, and RF terminals already run the mobile warehouse shell. Libraries added are limited to virtualisation and charting for the supervisor console; the scanning, event, and print pipelines are reused as-is rather than rebuilt.

## Scope note

This plan changes backend ownership as well as UI, because the audit's central defect is a duplicated business rule, not a presentation gap. If you'd rather I stop after Phase 1–2 (ledger unification plus the control plane) and defer the UI work, say so and I'll trim it.

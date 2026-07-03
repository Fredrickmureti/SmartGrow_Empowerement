# Payroll Schedules — Architectural Assessment & Phased Remediation

## 1. Verdict

The Schedules subsystem is **not** enterprise-grade. It is a thin CRUD surface over a calendar table with a single side-effect (locking timesheets). The HTTP 400 on `lock_timesheets_for_payroll` is a symptom; the real defect is that **there is no canonical Payroll Period business object** governing the payroll lifecycle. Multiple parallel constructs (`payroll_periods`, `pay_schedules`, `payroll_run_groups`, `payroll_runs`, `fiscal_periods`, `timesheets.payroll_locked`) each answer a slice of "is this window open?" independently, and none of them is authoritative.

## 2. What exists today (evidence)

| Construct | Role today | File |
|---|---|---|
| `payroll_periods` (table, 14 cols, status TEXT default `'open'`) | Monthly calendar. Two states used in code: `open` / `closed`. | `20260326183327_*.sql` |
| `pay_schedules` (weekly/biweekly/…/annual) | Frequency definitions consumed by `payroll_batch_create`. **No FK to `payroll_periods`.** | `20260507115814_*.sql` |
| `payroll_run_groups` (batches, ADR-0045) | The real orchestrator: rich state machine, events, readiness snapshots. **Does not reference `payroll_periods`.** | `payroll_batch_lifecycle_test.sql` |
| `payroll_runs` | Own status + `period_start/period_end` free-floating. | many |
| `generate_payroll_periods(org, year, business, period_type)` | **Monthly only** — silently ignores weekly/bi-weekly/semi-monthly/quarterly despite `pay_schedules.frequency` supporting them. Ignores `pay_schedules` entirely. | `20260326183327_*.sql:37` |
| `lock_timesheets_for_payroll(period_id)` | Flips approved timesheets → `payroll_locked=true`. Returns count. | `20260504223516_*.sql:258` |
| `unlock_timesheets_for_payroll(period_id, reason)` | Admin only, reason required, no audit-row insert visible in the function body itself. | `20260504223516_*.sql:280` |
| `payroll_periods_guard()` trigger | Blocks UPDATE/DELETE **only** when an overlapping posted/approved/paid/reversed run exists. Passive gate; does not govern. | `20260613170002_*.sql:182` |
| `usePayrollPeriods.closePeriod` | Two-step: RPC lock, then client `UPDATE payroll_periods SET status='closed'`. **Non-atomic.** | `src/hooks/usePayrollPeriods.ts:96-114` |
| `PayrollPeriodsAdmin.tsx` | List + "Close & lock timesheets" / "Reopen with reason". No blockers, no status of runs, no cross-module readiness. | `src/components/payroll/PayrollPeriodsAdmin.tsx` |

## 3. Weaknesses & disconnects

1. **No canonical period entity.** `payroll_periods`, `pay_schedules`, `payroll_run_groups`, and `payroll_runs.period_start/end` all describe overlapping windows with no referential link. A run can be created outside any `payroll_periods` row; a batch can be closed without touching `payroll_periods.status`.
2. **Trivial lifecycle.** `status TEXT` default `'open'`; UI toggles between `open`/`closed`. No enum, no state machine, no `preparing / processing / awaiting_approval / posted / paid / closed / reopened / archived / cancelled` states, no `closed_by / closed_at / closed_reason / reopened_by / reopened_at / reopen_reason` columns, no history table.
3. **Non-atomic close.** `closePeriod` calls the RPC then updates the row from the client under RLS. Partial-failure is invisible; the RPC's SECURITY DEFINER guard is bypassed for the status change (only the module-permission RLS applies). Likely origin of the 400: RPC name/arg drift or role check refusing the caller; but even after fixing it the two-step flow will silently drift.
4. **Locking is scoped to timesheets only.** Closing a period does **not** freeze:
   - `attendance` / `attendance_events` / `attendance_corrections`
   - `leave_requests` finalization
   - `payroll_work_entries` (has its own projector, no period lock)
   - `payslip_inputs` (manual variable earnings)
   - draft `payroll_runs` / `payroll_run_groups`
   - `journal_entries` posted from payroll
   - `payroll_remittances`, `payroll_return_runs`, `payroll_bank_export_files`
   - `payroll_correction_adjustments` (post-close correction path is undefined)
5. **No pre-close validation.** Nothing checks pending timesheet submissions, pending leave approvals, draft runs, unposted payroll journals, unpaid remittances, unfiled returns, failed calculations, incomplete correction runs, or unresolved `payroll_readiness_findings` for the period.
6. **Generator ignores pay_schedules.** `generate_payroll_periods` only understands `'monthly'`. A business on a `weekly` or `semimonthly` `pay_schedule` cannot produce matching periods. `pay_schedule_id` is not on `payroll_periods` at all.
7. **No business events.** No emission to `business_event_outbox` on period open/close/reopen — despite ADR-0045 batch events. Downstream services (finance close, reporting snapshots, notifications) have nothing to subscribe to.
8. **Reopen has no cascade.** `unlock_timesheets_for_payroll` unlocks timesheets and the client flips status back to `open`. Nothing reverses payroll runs, un-posts journals, invalidates remittances, or emits an audit event. In an ERP, reopening after posting is a *governed* event (maker-checker + reversal generation).
9. **Multi-business / multi-country blind.** `payroll_periods.business_id` was made NOT NULL client-side (hook comment) but the SQL still declares it nullable with `ON DELETE SET NULL`. Country/localization pack calendars (statutory return periods) are not linked.
10. **UI communicates nothing operational.** The admin panel shows name/dates/status/close-button. It does not show: current period, readiness blockers, run counts, approval state, posting state, remittance state, compliance state, or audit history.
11. **Symptomatic 400.** The RPC signature is `lock_timesheets_for_payroll(_payroll_period_id uuid)` with role-gated SECURITY DEFINER. A 400 typically means (a) arg name drift after a rename, (b) caller lacks `admin/hr_admin/payroll_admin`, or (c) the RPC is not in the exposed schema after a migration reset. Fixing it changes nothing architecturally.

## 4. Target architecture

Introduce a **Payroll Period Service** as the single source of truth. `payroll_periods` becomes the parent aggregate; every payroll-adjacent write consults it.

```text
                +----------------------+
                |  pay_schedules       |  (frequency, cutoffs, anchors)
                +----------+-----------+
                           |
                           v
+----------+     +----------------------+     +----------------------+
| fiscal_  |<----+  payroll_periods     +---->| payroll_run_groups   |
| periods  |     |  (aggregate root)    |     | (batches, ADR-0045)  |
+----------+     |  status enum + FSM   |     +----------+-----------+
                 |  pay_schedule_id FK  |                |
                 |  closed_by/at/reason |                v
                 |  reopen_by/at/reason |     +----------------------+
                 +----+-------+---------+     | payroll_runs         |
                      |       |               +----------+-----------+
        +-------------+       +--------------+          |
        v                                    v          v
+---------------+  +------------------+  +--------------------+
| timesheets    |  | attendance /     |  | payslip_inputs /   |
| payroll_lock  |  | leave / work_    |  | remittances /      |
|               |  | entries          |  | returns / bank exp |
+---------------+  +------------------+  +--------------------+
```

### 4.1 State machine (enum + transition table)

`open → preparing → processing → awaiting_approval → posted → paid → closed`
Side branches: `→ cancelled` (from open/preparing), `closed → reopened → preparing` (governed, audited), `closed → archived` (after retention window).

Enforced by trigger + `payroll_period_transition(period_id, next, actor, reason, payload)` RPC — mirror of `payroll_return_transition` (already the house pattern, see `return_run_state_machine_test.sql`).

### 4.2 Governed close (`payroll_period_close_atomic`)

Single SECURITY DEFINER RPC that, in one transaction:
1. Runs `payroll_period_readiness(period_id)` — aggregates: pending timesheets/leave/attendance, draft/failed runs, unposted JEs, unpaid remittances, unfiled returns, unresolved readiness findings.
2. Refuses if any blocker unless `force=true` + `override_reason` (audited).
3. Cascades locks: timesheets, attendance corrections, work entries, payslip inputs.
4. Flips status → `closed`, stamps `closed_by/at/reason`.
5. Inserts `pack_return_run_audit`-style audit row.
6. Emits `business_event_outbox` events: `payroll.period.closed`.

### 4.3 Governed reopen (`payroll_period_reopen_atomic`)

Maker-checker: admin + reason + optional second approver. Cascades: un-lock downstream, mark posted runs `requires_correction`, freeze new corrections behind an explicit correction-run workflow (already exists in `payroll_correction_adjustments`). Emit `payroll.period.reopened`.

### 4.4 Generator alignment

Replace `generate_payroll_periods(year, monthly-only)` with `payroll_periods_generate(pay_schedule_id, from, to)` that reads frequency, cutoff, payment offset, anchor day, and produces the correct calendar (weekly / biweekly / semimonthly / monthly / quarterly / annual). Keep the old signature as a thin shim that resolves the business's default monthly schedule for backward compatibility.

### 4.5 Cross-module gates (defense in depth)

- `timesheets` write trigger already blocks when locked — extend to check parent period status, not just `payroll_locked`.
- `payroll_runs` insert/update trigger: require the run's window to lie inside an `open|preparing|processing|awaiting_approval` period.
- `journal_entries` with `source_type='payroll'`: require parent period not in `closed|archived`.
- `payroll_remittances`, `payroll_return_runs`, `payroll_bank_export_files`: FK to `payroll_period_id` (nullable during transition, then required).

### 4.6 UI (operational workspace, not CRUD)

Mirror ADR-0041 pattern (Payroll Readiness workspace). Per period card shows: state chip, readiness score, counts per blocker category with drill-in links, run/approval/posting/payment/remittance/return status bars, audit trail, close/reopen governed buttons that surface the blocker list before firing the RPC.

## 5. Phased implementation plan

Each phase is independently shippable, backward-compatible, and gated by pgTAP + architecture tests.

### Phase 0 — Stabilize (1 day, symptom triage)
- Reproduce the 400: verify RPC signature, caller role, and exposed schema; fix the immediate cause (likely a role check or arg-name drift).
- Add a pgTAP test pinning `lock_timesheets_for_payroll` / `unlock_timesheets_for_payroll` arity so it can't drift silently again.
- No behavior change.

### Phase 1 — Period aggregate hardening (schema)
- Enum `payroll_period_status` with the 9 states above; migrate `status TEXT` with a `USING` clause; add CHECK on legal set.
- Columns: `pay_schedule_id uuid FK`, `closed_by`, `closed_at`, `close_reason`, `reopened_by`, `reopened_at`, `reopen_reason`, `readiness_snapshot_id`.
- Make `business_id` NOT NULL (backfill first; hook already assumes it).
- Add `pack_return_run_audit`-style `payroll_period_audit` table.
- Grants + RLS as per house rules.
- pgTAP: contract test for columns + enum values.

### Phase 2 — State machine + governed RPCs ✅ shipped
- `payroll_period_transition(period_id, next, actor, reason, payload jsonb)` with transition matrix + audit insert.
- `payroll_period_readiness(period_id)` returns structured blocker jsonb (reuses `payroll_readiness_*` engine per ADR-0041).
- `payroll_period_close_atomic(period_id, force, override_reason)` — replaces the two-step hook path.
- `payroll_period_reopen_atomic(period_id, reason, second_approver)`.
- Deprecate direct client `UPDATE payroll_periods SET status=…`; add trigger refusing UPDATE of `status` unless done by these RPCs (using `set_config('app.period_rpc',…)` sentinel, same pattern used by return-runs).
- pgTAP: 8-state edge matrix; illegal transitions raise.

### Phase 3 — Cross-module lock cascade ✅ shipped (3a); 3b deferred
- Extend `lock_timesheets_for_payroll` into `payroll_period_apply_locks(period_id)` covering timesheets, attendance_corrections, work_entries, payslip_inputs.
- Add insert/update guards on `payroll_runs`, `journal_entries` (payroll source), `payroll_remittances`, `payroll_return_runs`, `payroll_bank_export_files` that consult period status.
- Emit `business_event_outbox` rows on close/reopen; wire notification digest.

### Phase 4 — Generator alignment with pay_schedules
- New `payroll_periods_generate(pay_schedule_id, from, to)` implementing all frequencies.
- Backfill `pay_schedule_id` on existing rows via best-match by business + frequency.
- Keep `generate_payroll_periods` as a shim; add deprecation notice.

### Phase 5 — Readiness workspace UI
- Replace `PayrollPeriodsAdmin.tsx` with a per-period operational card (readiness score, blocker list with deep links, run/JE/remittance/return badges, audit timeline).
- New hook `usePayrollPeriodDetail(periodId)` consuming `payroll_period_readiness` and audit rows.
- `closePeriod` / `reopenPeriod` in `usePayrollPeriods` route through the atomic RPCs; toasts show blocker summary when refused.
- Architecture test forbidding client `UPDATE payroll_periods SET status`.

### Phase 6 — Correction & archival
- Formalize `closed → reopened → preparing → closed_v2` path emitting correction runs (leverages existing `payroll_correction_adjustments`).
- `payroll_period_archive(period_id)` after retention window; archived periods refuse all writes, including reopen, without platform-admin override.
- Multi-country: add `country_code` on `pay_schedules` for statutory calendar alignment; wire `payroll_return_runs.period_id`.

## 6. What to retire

- Direct client update of `payroll_periods.status` (both close and reopen).
- Monthly-only assumption in `generate_payroll_periods` (kept as shim only).
- Any component using `p.status === "open"` heuristics — replace with the enum + helper `getPeriodLifecycle(period)` mirroring `getRunLifecycle` in `src/lib/payroll/runLifecycle.ts`.

## 7. Non-goals for this plan

- No changes to the payroll calculation engine, GL posting rules, or return templates. Those are consumers of period status, not owners.
- No new UI framework or design system work; reuse the Payroll Readiness workspace idioms.

## 8. Success criteria

- One canonical period aggregate; all payroll-adjacent writes reject when the parent period is `closed`/`archived`.
- Close/reopen are single atomic RPCs with structured blockers, audit rows, and outbox events.
- Generator supports every `pay_schedules.frequency`.
- pgTAP suite covers state machine, cascade locks, generator parity, and RPC arity.
- Admin UI shows operational reality of every period (status, blockers, downstream state, audit) — not a status toggle.

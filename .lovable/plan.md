# Payroll Run Progress — Fix + Enterprise Redesign

## Why the card shows "succeeded · 0 / 1 employees"

Traced end-to-end. The card is faithful — the bug is in the worker, not the UI.

**`supabase/functions/compute-payroll/index.ts`**
- Line 2684 only heartbeats progress on `payslipsData.length % 5 === 0`, so runs with fewer than 5 employees never increment `progress_current`.
- `finalizeJob("succeeded", …)` (line 1147) writes `status`, `finished_at`, `result`, `payroll_run_id` but does **not** set `progress_current = progress_total`. The terminal row stays at `0 / 1`.
- `PayrollJobPanel` (line 111–117) renders `progress_current / progress_total` directly, so the stale server value bleeds through.

Net effect: any run of <5 employees, and every run at the finish line, misreports progress.

## Scope

Fix the underlying bug, then rework the card into the enterprise-grade tracker the user described (real-time, professional, optional completion chime). No changes to payroll engine math, RPCs, or accounting.

## Plan

### Phase 1 — Server correctness (authoritative truth)

1. **Heartbeat every employee**, not every 5th.
   - In the `for (const emp of employees)` loop, replace the mod-5 gate with an unconditional `await heartbeat("computing", { current: payslipsData.length, total: employees.length })` at the top of each iteration (still cheap: one UPDATE per employee).
   - Add a post-employee heartbeat after `payslipsData.push(...)` so the counter reflects *completed*, not *in-flight*, work.
2. **`finalizeJob` snaps progress to terminal state.**
   - On `succeeded`: also write `progress_current = progress_total` (fallback to `employee_count` if `progress_total = 0`), and `phase = "completed"`.
   - On `failed` (both `finalizeJob` and the outer catch at line 5484): write `phase = "failed"` and leave counters as they were so operators see how far it got.
3. **Phase labels normalized** to a fixed enum so the UI can drive icons/copy: `queued → preparing → computing → posting → completed | failed | cancelled`.

### Phase 2 — Card redesign (`src/components/payroll/PayrollJobPanel.tsx`)

Replace the current single-row card with an enterprise tracker. Same file, same hook (`useActivePayrollJobs`), no new realtime channels.

Structure per job:
```text
┌─ Payroll · May 2026 (regular) · Attempt 1 ────────── [succeeded] ─┐
│  ● Preparing   ●  Computing   ●  Posting   ●  Completed           │
│  ████████████████████████████████████████████████████ 100%        │
│  12 of 12 employees processed · finished 2 min ago · 34 s elapsed │
│  0 warnings · Journal entry JE-2026-0518 posted                   │
│  [ View run ]  [ Download payslips ]  [ Cancel ]                  │
└───────────────────────────────────────────────────────────────────┘
```

Visual/UX rules:
- **Semantic tokens only** (`--primary`, `--muted`, `--success` if defined; add `--success` HSL to `index.css` if missing). No hardcoded `text-green-600`.
- **Phase stepper** (4 dots) driven by normalized `phase`; completed phases filled, current phase pulsing, future phases muted.
- **Progress bar always reflects reality**: when `status = "succeeded"` force `pct = 100` and counter `= progress_total || employee_count`, so even if a legacy row lands with stale counters the UI is truthful.
- **Elapsed time** ticks live via a 1 s `setInterval` while `status ∈ {queued, running}`; frozen at `finished_at - started_at` when terminal.
- **Density**: compact mode when >1 active job (collapse detail row); expanded when a job is the sole active one.
- **Terminal auto-dismiss**: keeps the 15-min recentTerminal window but adds a small "Dismiss" affordance.
- **Accessibility**: `role="status"` + `aria-live="polite"`; each phase dot has `aria-label`; progress bar has `aria-valuenow`.

### Phase 3 — Completion sound (opt-in, respectful)

- Ship two short WAVs (`success.wav` ~500 ms soft two-note chime, `failure.wav` ~400 ms low tone) under `src/assets/sounds/`.
- Play once per job transition `running → succeeded | failed`, detected in `PayrollJobPanel` by diffing prev vs next status per `job.id` in a ref.
- Guardrails:
  - **User preference**: setting stored in `localStorage` key `payroll.jobPanel.sound` (`on | off`), default **on**. Toggle mounted in the panel header (speaker icon).
  - Respect browser autoplay policy — swallow rejected `audio.play()` promises silently.
  - Never play on initial mount (only on observed transition), never for jobs older than 60 s at mount time.
  - Skip when `document.hidden === false` is not required; do fire when tab is backgrounded so accountants notice.
- No sound framework — a plain `HTMLAudioElement` per file, lazily constructed.

### Phase 4 — Verification

- Manual: run a 1-employee payroll, confirm bar reaches 100% and counter reads `1 / 1`.
- Manual: run ≥5 employees, confirm counter ticks every employee (not every 5).
- Manual: simulate failure via unmapped GL key, confirm phase = "failed", counter frozen at last completed employee, failure chime plays once.
- Add a unit test on the card: given `{ status: "succeeded", progress_current: 0, progress_total: 1, employee_count: 1 }`, it renders "1 / 1" and 100%.
- Update plan/audit docs (`.lovable/plan.md`) with a new "Payroll Job Panel Hardening" entry under Phase-current.

## Out of scope

- Payroll engine math, GL posting, RLS, or any change to `payroll_run_jobs` schema (all fields we need already exist).
- Notifications outside the panel (email/push/toast) — the panel is the single source of truth per existing ADR.
- Multi-tenant sound settings; single per-browser toggle is enough for v1.

## Files touched

- `supabase/functions/compute-payroll/index.ts` (heartbeat every employee, terminal snap in `finalizeJob`, phase enum).
- `src/components/payroll/PayrollJobPanel.tsx` (redesign, sound, elapsed timer, sound toggle).
- `src/assets/sounds/success.wav`, `src/assets/sounds/failure.wav` (new).
- `src/index.css` — add `--success` token if not present.
- `.lovable/plan.md` — log the hardening entry.
- Optional: `src/components/payroll/__tests__/PayrollJobPanel.test.tsx`.

## Next-agent handoff

After merge: verify by running a 1-employee payroll on the preview tenant and confirming (a) `payroll_run_jobs.progress_current = progress_total` at terminal state via `supabase--read_query`, (b) card shows 100% and matching counter, (c) success chime plays once with sound toggle on and is silent with it off.

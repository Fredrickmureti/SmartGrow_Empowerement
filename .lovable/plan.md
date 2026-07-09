## Root cause of the "Post to ledger" failure

`physical_count_post` creates a `stock_adjustments` row with `created_by = p_user_id` (the poster), then in the same call updates it to `status = 'approved'` with `approved_by = p_user_id`. The BEFORE-UPDATE trigger `guard_stock_adjustment_self_approval` runs `governance_assert_not_self(approved_by, created_by, ...)` — since both equal the poster, it raises `ERRCODE 42501` (permission denied). PostgREST returns HTTP 400. On the client, `normalizeError` maps 42501 → the canned "Not allowed / permission denied" text (and in this project, without a `status` on the error object, falls through to `unknown` → "An unexpected error occurred"). That's why the toast is generic and the console is empty.

SoD is already fully enforced at the `physical_counts` layer (creator ≠ submitter ≠ approver ≠ poster, with server-side preflight and explicit override). Re-enforcing SoD on the *derived* `stock_adjustments` row via poster-vs-poster is a false positive — that row is a machine-emitted side-effect of the count post, not an independent adjustment.

## Second issue

`src/pages/inventory/CycleCountSchedules.tsx` exposes internal identifiers to end users:
- Title/description says "draft `physical_counts` row via `generate_due_cycle_counts()`" — table and function names in the UI.
- Sheet description mentions `next_run_at` and `pg_cron`.
- Header caption uses "cycle counts feed draft physical-counts into your workspace" — jargon.
- Nothing explains what cycle counting is, what a cadence means, what tolerance does, what "scope" filters, or what happens when it runs.

## Fix

### 1. Unblock the post (migration)

Rewrite `physical_count_post` so the auto-generated `stock_adjustments` row records the true actors and does not trip SoD:

- `created_by := v_c.approved_by` (the approver of the count is the operational "creator" of the derived adjustment)
- `approved_by := p_user_id` (the poster)
- Because the physical-count lifecycle already guarantees `approved_by ≠ posted_by` (SoD in `physical_count_post` itself, unless `p_allow_self`), `approved_by ≠ created_by` on the derived row, so `guard_stock_adjustment_self_approval` passes.
- Fallback: if `v_c.approved_by IS NULL` (should not happen in `approved` state) or equals `p_user_id` (self-override path), stamp `created_by := COALESCE(v_c.submitted_by, v_c.created_by, p_user_id)` and, if still equal, set a session-local bypass `SET LOCAL app.governance_self_bypass = 'physical_count_post'` and have the guard honour it (narrow, auditable, mirrors the existing `app.physical_count_freeze_override` pattern).

Preferred: use the actor-reassignment approach (no new bypass flag) — cleaner and still passes SoD in the self-override edge case because we explicitly log the override in `physical_count_events.payload.allow_self`.

Also: surface a clearer, deterministic error on the RPC — wrap the `UPDATE stock_adjustments ... approved` in an exception handler that re-raises with a business-facing message ("The generated inventory adjustment could not be approved — …").

### 2. Improve client error surfacing

In `PhysicalCountDetail.runRpc`, when `error.message` from Supabase contains a business message (P0001 / 42501 raises), pass it through instead of the canned catalog text. Do this narrowly: if the Supabase error has a non-empty `message` and (`code` starts with `P` or `code = '42501'`), show that message directly via `toast.error(err.message)`. Keep `normalizeError` for network/auth/unknown categories.

### 3. Rewrite `CycleCountSchedules.tsx` in business language

No more table names, function names, or column names in the UI. Replace with plain English an inventory manager understands.

- **Page header:**
  Title: "Cycle counting"
  Subtitle: "Automatically schedule small, recurring stock counts so you never rely on a single year-end count. Each schedule picks a warehouse and a rotation, and drops a ready-to-count worksheet into Physical Counts on its due date."
- **Toolbar buttons:**
  "Run now" (was "Run due now") with tooltip "Check every active schedule and create today's count worksheets immediately, instead of waiting for the overnight run."
  "New schedule".
- **Empty state:** "No cycle counts scheduled yet. Create a schedule to have the system automatically prepare count worksheets on a rhythm — e.g. count your A-class items every week, everything else every quarter."
- **Table caption (replaces the code sentence):** "Schedules run automatically overnight. Use *Run now* to generate today's worksheets on demand."
- **Column tweaks:** "Cadence" → "How often"; "Scope" → "What to count" with human labels ("Entire warehouse", "A-class items", "Category: <name>", "Selected products"); "Next run" → "Next count due"; "Last run" → "Last generated".
- **Create/edit sheet:**
  - Title: "New cycle count schedule" / "Edit cycle count schedule".
  - Description: "Cycle counting means counting a slice of your stock on a regular rhythm instead of shutting the warehouse for a full count. Configure how often to count, what to count, and how large a variance is acceptable before requiring investigation."
  - Field help text:
    - Name — "A label your team will recognise, e.g. *Weekly A-class — Main warehouse*."
    - Warehouse — "Which warehouse this rotation applies to."
    - How often — "How frequently the system should generate a new count worksheet."
    - What to count — options relabelled ("The entire warehouse", "Only A/B/C class items", "A specific product category", "A hand-picked product list").
    - Tolerance % — "Variances smaller than this are auto-accepted. Larger variances are flagged for review before posting."
    - Tolerance value — "Same idea, but as a money amount. Use whichever suits the products in scope."
    - Auto-freeze on generation — "When on, the worksheet skips 'Draft' and locks stock immediately so counters can start straight away. Leave off if you want a supervisor to review before locking stock."
    - Active — "Paused schedules stop generating new count worksheets."

### 4. Guards / tests

- Update `src/__tests__/architecture.physical-count-lifecycle.test.ts` (or add a sibling test) to assert `CycleCountSchedules.tsx` contains no raw identifiers: no `physical_counts`, no `generate_due_cycle_counts`, no `next_run_at`, no `pg_cron`, no backticks around code identifiers.
- Add a pgTAP-style or SQL smoke test in `supabase/tests/` (if the folder is used) that: creates a count, freezes, counts a line, submits with user A, approves with user B, posts with user C, and asserts the derived `stock_adjustments` row lands `status='approved'` without the SoD trigger raising.

## Technical details

Files touched:
- New migration `supabase/migrations/<ts>_physical_count_post_sod_fix.sql` — CREATE OR REPLACE `physical_count_post(p_count_id, p_user_id, p_allow_self)`, only the block that INSERTs `stock_adjustments` and UPDATEs it to approved is changed; also improves the error message on the approval UPDATE.
- `src/pages/inventory/PhysicalCountDetail.tsx` — refine `runRpc` catch to prefer server-supplied P0001/42501 message.
- `src/pages/inventory/CycleCountSchedules.tsx` — copy overhaul only (no logic change).
- `src/__tests__/architecture.cycle-count-copy.test.ts` (new) — string-level guard against jargon regressions.

Non-goals: no changes to `_pc_immutable_after_post`, `enforce_physical_count_freeze`, `physical_count_preflight`, `physical_count_preview_je`, or the D6/D7/D8 scope. No new RLS. No schema changes.

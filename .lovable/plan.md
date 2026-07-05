# Payroll Posting Architecture Audit — Findings & Remediation

## 1. Business event under investigation

**"Post payroll to GL"** is a single, indivisible accounting event that, on execution, MUST:

1. Create exactly one balanced `journal_entries` row (`source_type='payroll'`, `source_id=run.id`) with its balanced `journal_entry_lines` (Salary DR, statutory payables CR, employer expenses DR, employer payables CR, net-pay clearing CR).
2. Insert `payroll_liabilities` rows (idempotent per `(payroll_run_id, rule_code)`) that feed remittances and payment batches.
3. Transition `payroll_runs.status` `approved → posted` and stamp `posted_by / posted_at`.
4. Write an `audit_logs` entry (`action='payroll_posted'`).
5. Become the ONLY event that can create these artefacts. It is idempotent by `(source_type,'payroll', source_id=run.id)`.

**"Simulate posting"** is a read-only projection of that same event: it answers *"what JE would this run produce right now?"* and MUST NOT touch `journal_entries`, `payroll_runs.status`, `payroll_liabilities`, `payroll_liability_sources`, `payment_requests`, `audit_logs`, or any lock/period record. In enterprise ERPs (SAP HCM, Workday, Oracle Fusion, D365 F&O, Odoo, Sage, ADP) simulation is bound to a **specific run in its approval stage**, not to a configuration screen.

## 2. What the current implementation actually does

Traced end-to-end through `supabase/functions/post-payroll-gl/index.ts`, `src/hooks/usePayrollGL.ts`, `src/components/payroll/PayrollPostingSimulator.tsx`, `src/pages/hr/payroll/AccountMapping.tsx`, `src/components/payroll/PayrollRunDetailsDialog.tsx`.

### 2a. Simulation entrypoint
`PayrollPostingSimulator` invokes `post-payroll-gl` with `dry_run: true`, picking the **latest draft/computed run for the org** — the accountant does not select the run; the UI does. This is architecturally wrong: simulation is a run-scoped operation.

### 2b. Shared code path (root cause of the reported symptom)
Both `dry_run=true` and real posting execute the **same prelude** in `post-payroll-gl/index.ts`:
- Auth, entitlement, permissions (lines 57–111).
- SoD gate `user_can_post_payroll` (lines 130–150) — this helper requires `status='approved'`, so simulating a `draft`/`computed` run raises `PERMISSION_DENIED` in the SoD branch even though nothing is being posted. Simulation is currently gated by a control designed for the writing step.
- **Idempotency short-circuit at lines 163–177**: if any `journal_entries` row exists with `source_type='payroll'` and `source_id=run.id` and `status<>'voided'`, the function returns `{ already_posted: true, journal_entry_id }` **regardless of `dry_run`**. Because the simulator and the real post button both hit this branch:
  - If a prior test/attempt left a JE for that run, `Simulate Posting` returns `already_posted:true` and the toast reads *"This run has already been posted to the GL — no preview to generate."*
  - Immediately afterwards `Post Payroll` returns the same body and the toast reads *"Already Posted"*.
  - The run stays `draft` because no code ever moved it out of draft — but the user perceives the two toasts as *simulation posted my payroll*.
- Fiscal period lock check (lines 179–194).
- Resolver + binding + role validation (lines 411–500). No writes.
- JE line build (lines 500–730). No writes.
- **`dry_run` early return at lines 737–771** — this branch itself is side-effect-free.
- Actual writes (lines 774–1010): `post_journal_entry_atomic`, `payroll_runs.update({status:'posted'})`, `payroll_liabilities.upsert`, `payroll_liability_sources.insert`, `audit_logs.insert`.

### 2c. Verdict on the reported bug
Simulation is **not** currently writing a JE. But the **shared idempotency check runs before the `dry_run` branch**, so it emits an `already_posted` signal for simulate and post identically. Combined with the mis-placed "latest run" auto-selection, this creates the exact perceived sequence *simulate → completed → post → already posted*. In enterprise terms this is a **workflow-integrity defect**: simulation and posting share a state check that only the writing step is allowed to reach.

### 2d. Additional architectural weaknesses uncovered
1. **SoD gate applied to simulation** blocks previews before approval — the opposite of what an accountant needs (they want the preview to validate mappings *while still in draft*).
2. **`Simulate Posting` lives in `Configuration → GL Account Mapping`**, not on a run. It cannot preview per-run since it always picks the latest draft/computed row.
3. **No explicit `posted` state gate** — `post-payroll-gl` will write for a run in any status other than `posted` (there is no `status='approved'` precondition inside the function; only `user_can_post_payroll` enforces it, and that is a role check not a state assertion).
4. **No `posting_preview` domain event or artefact**. Enterprise systems record who previewed what and when; ours emits nothing.
5. **No proof that simulation is side-effect-free** in tests. `payroll-completion-guards.test.ts` locks balanced-JE and idempotency, but nothing asserts "dry_run performs zero writes".
6. **`already_posted` conflates two very different states** — *"a JE exists"* vs *"this posting attempt is a no-op replay"*. The UI can't tell them apart.

## 3. Target architecture (aligned with SAP HCM / Workday / Oracle HCM / D365 / Odoo)

```text
 draft ─► computed ─► approved ─────► posted ─► paid ─► remitted ─► closed
                       │                ▲
                       └── preview ─────┘   (read-only, run-scoped, any pre-post state)
```

Rules:
- **Preview** is a pure function of `(run, mappings, pack, period)` → returns projected lines + validation issues. No writes. Callable from `computed` or `approved` states. Never from `posted`.
- **Post** is the sole writer. Requires `status='approved'`, all mappings valid, period open, poster ≠ creator/approver, no existing non-voided JE. Atomic RPC.
- **Idempotency** for post is: replay of the identical post request returns the existing JE (`replayed:true`), *never* surfaced to the preview path.
- **Preview surface** is attached to the run (row action + run details dialog), not to the mapping configuration page. The mapping page keeps only *"Validate mappings"* (no JE projection).

## 4. Implementation plan

### 4a. Server — split preview from post (`supabase/functions/post-payroll-gl/index.ts`)
1. Move the idempotency check (lines 163–177) **below the `dry_run` branch**. Preview must never short-circuit on JE existence; it must instead include an `already_posted` boolean *inside the preview payload* so the UI can render a read-only badge without conflating states.
2. Skip the `user_can_post_payroll` SoD gate when `dry_run=true`. Replace with a lighter `payroll.read` + `financials.read` permission check for preview. SoD only applies to writers.
3. Skip the fiscal-period `closed` hard-fail on `dry_run`; instead include `{warnings:[{code:'period_closed', ...}]}` in the preview response so the accountant sees the issue.
4. On the write path, add an explicit precondition `payrollRun.status === 'approved'` and return `409 { error:'invalid_state', current_status }` otherwise. This makes "posted" reachable only from "approved".
5. Wrap all writes (JE atomic RPC, `payroll_runs.update`, `payroll_liabilities.upsert`, `payroll_liability_sources.insert`, `audit_logs.insert`) behind a single `if (!dryRun)` guard block for defensive symmetry, and add an assertion at the top of that block that `dryRun === false`.
6. Emit a `posting_previewed` `audit_logs` row (non-financial, `action='payroll_posting_previewed'`) on every dry-run — for auditability, without touching accounting state.

### 4b. Client — relocate & rescope the simulator
1. Remove `<PayrollPostingSimulator />` from `src/pages/hr/payroll/AccountMapping.tsx` (line 187).
2. Rebuild it as `PayrollPostingPreviewDialog(runId)` and mount it:
   - As a row action on the Payroll Runs list for `computed`/`approved` rows ("Preview posting").
   - Inside `PayrollRunDetailsDialog.tsx` beside the existing "Post to GL" button.
3. Preview dialog shows: projected DR/CR lines with account code/name/type, balance status, missing mappings (deep-link to mapping page), period warnings, and — when `already_posted:true` — a read-only banner linking to the existing JE (no toast confusion).
4. On the mapping page, replace the removed button with a `Validate mappings` action that calls `payroll_validate_post_mappings` only (no JE projection, no run selection).
5. Update `usePayrollGL.postPayrollToGL` so `already_posted` is treated as an idempotent replay outcome (info, not error), and refetch run status.

### 4c. State-machine hardening (DB)
1. New migration: add a `BEFORE UPDATE` trigger on `payroll_runs` that rejects `status` transitions outside `{draft→computed, computed→approved, approved→posted, posted→paid, paid→remitted, remitted→closed}` plus explicit reversal transitions. Prevents any code path from silently jumping states.
2. Add a partial unique index `journal_entries (source_type, source_id) WHERE source_type='payroll' AND status<>'voided'` if not already present, to make the "one JE per run" invariant a DB-level guarantee, not an application check.

### 4d. Tests (architecture + integration)
Add under `src/test/architecture/`:
1. `post-payroll-gl-dry-run-is-readonly.test.ts` — greps the edge function to lock: every mutation (`.insert(`, `.update(`, `.upsert(`, `.delete(`, and the `post_journal_entry_atomic` RPC) is inside a `if (!dryRun)` block; `dry_run` branch returns before the write region.
2. `post-payroll-gl-idempotency-not-in-dry-run.test.ts` — asserts the JE-existence short-circuit is reached only on the write path; dry-run must include `already_posted` in the payload instead of returning it early.
3. `payroll-preview-not-on-mapping-page.test.ts` — asserts `AccountMapping.tsx` does not import `PayrollPostingSimulator`.
4. `payroll-post-requires-approved-status.test.ts` — asserts the edge function contains the `status === 'approved'` precondition.
5. Extend `payroll-completion-guards.test.ts` with a "SoD gate skipped on dry_run" assertion.

### 4e. Docs
Add `docs/adr/00XX-payroll-posting-simulation-boundary.md` documenting: business event vs preview, side-effect boundary, state machine, benchmark to SAP/Workday/Oracle/Odoo.

## 5. Out of scope
- Changing the JE line composition, statutory rulebook resolution, or pack semantics.
- Payment batch / remittance workflow (already correct downstream of `posted`).
- UI restyle beyond moving the button and the new preview dialog copy.

## 6. Deliverable order
1. Migration (state-machine trigger + unique index).
2. Edge function refactor (split dry_run before idempotency/SoD/period gates; add posted-only precondition; audit log for preview).
3. Client: remove button from mapping page; add run-scoped preview dialog; wire into runs list + details dialog; add `Validate mappings` action.
4. Architecture tests.
5. ADR.

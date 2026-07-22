## Findings (from tracing the actual code, not the symptom)

**1. `claim_next_business_event` is not the payroll pipeline.** It is called by `src/services/events/BusinessSaga.ts` from a client-side `setInterval` (every 4s, in every open tab, mounted globally via `BusinessSagaMount`). Its job is to drain hardware-scoped rows out of `business_event_outbox`. Payroll never enters this call path. The `POST .../rpc/claim_next_business_event` failing with `net::ERR_FAILED` in DevTools is the background poller, not the payroll invocation.

**2. Payroll actually runs via one synchronous edge-function call.** `supabase.functions.invoke("compute-payroll", …)` from `src/pages/hr/payroll/Runs.tsx` and `ReversePayrollDialog.tsx`. `compute-payroll/index.ts` is **5,157 lines** of sequential per-employee work in a single invocation: validation → contracts → rules → statutory → payslip inserts → readiness → issues. No chunking, no job row, no resumability.

**3. The UI conflates "fetch failed" with "payroll dropped".** `src/lib/edgeFunctionError.ts` maps every `FunctionsFetchError` / `Failed to fetch` / `AbortError` to a single `OFFLINE` code, and `Runs.tsx` renders `"Connection dropped while running payroll"`. So an edge-runtime wall-clock kill, a CPU/memory kill, a large-response abort, or a mid-invoke reconnect **all** look like a dropped internet connection to the user.

**4. The real failure mode.** For any non-trivial employee count, `compute-payroll` can exceed edge-runtime CPU/wall-time or return a payload big enough that Supabase's fetch pipeline drops the connection. The client sees `Failed to fetch`, the classifier says OFFLINE, and the message says the connection dropped — hiding the architectural weakness. Meanwhile the DB may have already been mutated inside the function's own transactions, so retrying can create duplicate payslips.

**5. Business-event coupling is (mostly) correct — but weakly enforced.** Domain events land in `business_event_outbox` inside the same DB transaction as the write (outbox pattern, ADR-0076). Payroll does NOT synchronously depend on the saga finishing. The saga just drains them later. So the fix does not require rewiring events; it requires stopping the payroll UI from treating the saga's transient poll failures — and its own oversized invoke — as a payroll failure.

## Architectural verdict

- Payroll is **not** blocked by the business-event engine.
- Payroll **is** blocked by being a single synchronous edge-function call with no job model, no idempotency across retries, and no server-side progress the UI can poll.
- The "connection dropped" copy is a symptom classifier, not a diagnosis. It is masking the real weakness.

## Execution plan

**Phase 1 — Stop the misdiagnosis (small, safe, unblocks users today)**

1. `edgeFunctionError.ts`: split the `OFFLINE` bucket into `OFFLINE` (only when `navigator.onLine === false`) vs `TRANSPORT_FAILED` (fetch failure while online). Return distinct copy: "The payroll engine did not respond. Your payroll may still be running — do not retry until you refresh this page and check the run's status."
2. `Runs.tsx` / `ReversePayrollDialog.tsx`: on `TRANSPORT_FAILED`, do **not** claim "no changes were saved". Instead force a refetch of `payroll_runs` for the target period and surface whichever run was created (draft, computing, failed).
3. Add a client-side idempotency key (UUID per submit) to the `compute-payroll` invoke; the edge function short-circuits if a run with that key already exists. Prevents the "user hits retry and gets duplicate payslips" hazard the current retry copy creates.
4. Verify `BusinessSaga.tick()` swallows RPC errors quietly (it already returns on `error`) — confirm it does not surface to the payroll UI. Add a guard so a failed `claim_next_business_event` never bubbles into `window.onerror` / global toast.

**Phase 2 — Make payroll execution resumable (the real fix)**

5. Introduce a `payroll_run_jobs` control row (status: `queued` → `computing` → `computed` → `failed`, plus `progress`, `last_employee_id`, `error_json`, `idempotency_key`). The invoke becomes: create/find the job (idempotent on key), then return `{ job_id }` immediately. Actual compute is driven off a stateless worker.
6. Refactor `compute-payroll` into **chunks of N employees per invocation** (N tuned to fit inside edge-runtime CPU + memory), each chunk a separate transaction that advances `payroll_run_jobs.last_employee_id`. On chunk completion the function enqueues the next chunk via an outbox row consumed by `outbox-dispatcher` (already exists). No single invocation processes the whole run.
7. Per-employee compute stays in a savepoint, so a rule failure marks that employee `failed` in `payroll_run_issues` and continues instead of aborting the whole run.

**Phase 3 — UI reflects execution truth**

8. Runs page subscribes to `payroll_run_jobs` via realtime (or polls every 2s while `status IN ('queued','computing')`) and shows real progress ("payroll: 128/402 employees"). Retry button is only enabled when `status='failed'` and reuses the same idempotency key.
9. Kill the raw `"Connection dropped"` string. Replace with three distinct states: **queued / running / needs attention** driven by `payroll_run_jobs.status`, never by fetch-error shape.

**Phase 4 — Observability & guards**

10. Structured logs in `compute-payroll`: `run_id`, `chunk_index`, `employees_in_chunk`, `duration_ms`, `error_code`. Shipped to `payroll_rule_traces` / a new `payroll_run_job_events` table for post-mortem.
11. Architecture test: forbid re-introducing a single-invocation full-run compute path; forbid raw `"Failed to fetch"` → `"Connection dropped"` copy without the `TRANSPORT_FAILED` split.
12. DB trigger: `payroll_run_jobs` cannot transition `computed → *` without an audit row; concurrent claims are prevented by `FOR UPDATE SKIP LOCKED` on the job row (same pattern as `claim_next_business_event`).

## Out of scope (called out but deliberately not changed)

- The business-event outbox pattern itself. It is already correctly async-after-commit and is not on payroll's critical path.
- Increasing any timeout. The plan removes the need for the current wall-clock to be enough.
- Any change to `claim_next_business_event`'s RLS or scope. The observed error there is orthogonal; Phase 1 step 4 just stops it from being misread as a payroll failure.

## Technical notes

- Chunk driver: reuse `business_event_outbox` + `outbox-dispatcher` — emit `payroll.chunk.requested` inside the same tx that advances `last_employee_id`. Guarantees at-least-once, and the job row's per-employee unique constraint gives exactly-once effects.
- Idempotency: `payroll_run_jobs (org_id, business_id, period_id, run_type, idempotency_key)` unique.
- RLS: only payroll-write can insert into `payroll_run_jobs`; the edge function reads/updates via `supabaseAdmin` after verifying the caller with `requireSupabaseAuth`-equivalent JWT parsing (this is a Supabase edge function, so verify the JWT in-code — see edge-function knowledge).
- No Node-only deps introduced; all work stays within Supabase edge runtime + Postgres.

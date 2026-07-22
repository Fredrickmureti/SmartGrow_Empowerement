# Payroll Execution — Architectural Remediation

## Verdict

The current model is **request-driven pretending to be job-driven**. `payroll_run_jobs` exists as a control row, but the *engine* still runs inline inside the HTTP request that created it. When the request dies (timeout, network blip, tab close), the UI loses its only handle to the work and the user is stranded — even though on the server side the job row is real and reachable.

Two invariants are violated:

1. **State ownership** — the browser's pending HTTP call is treated as the source of truth. It must be `payroll_run_jobs`.
2. **Execution durability** — the engine is coupled to the caller's socket. A long-running enterprise process must survive the caller disconnecting.

Fixing the toast copy or raising the timeout does not address either. The remediation below decouples *acceptance* from *execution* and makes the UI a subscriber to server state.

## Target model

```text
UI ── invoke ──► compute-payroll (accept only)
                     │
                     │ insert/lock payroll_run_jobs (status=queued)
                     │ enqueue business event: payroll.job.queued
                     ▼
              returns 202 { jobId } within ~1s
                     │
UI subscribes to payroll_run_jobs realtime + progress rows
                     │
                     ▼
        payroll-worker (invoked by DB webhook / cron / event)
          claims job (status=running, worker_id, heartbeat_at)
          streams phase + per-employee progress rows
          finalises job (succeeded | failed | cancelled)
```

Key properties:

- Acceptance and execution are **separate transactions**.
- The job row is the **single source of truth**; UI never infers state from the HTTP promise.
- The worker is **idempotent, resumable, and heartbeated**. A crashed worker is reclaimed by a stale-heartbeat sweeper.
- Every meaningful transition is a **business event** the UI observes over Realtime.

## Plan

### 1. Split accept vs. execute

- `compute-payroll` becomes an **accept-only** endpoint. It:
  - validates payload,
  - upserts `payroll_run_jobs` by `(organization_id, idempotency_key)` with `status='queued'`,
  - emits `payroll.job.queued` into `business_event_outbox`,
  - returns `202 { jobId, status, replay? }` in <2s.
- If a matching job is `running` → return current snapshot (200), never 409-block the UI.
- If `succeeded` → replay stored `result` (idempotent).

### 2. New `payroll-worker` edge function

- Triggered by (a) a DB `pg_net` webhook fired from the outbox trigger, and (b) a `pg_cron` sweeper every minute for missed/stale jobs.
- Claims a queued job with `SELECT … FOR UPDATE SKIP LOCKED`, stamps `worker_id`, `started_at`, `heartbeat_at`.
- Runs the existing engine **unchanged mathematically**, but wrapped so it:
  - updates `heartbeat_at` every N employees,
  - writes phase transitions to a new `payroll_run_job_events` table,
  - writes per-employee progress to a new `payroll_run_job_progress` table (employee_id, status, error),
  - commits final state via `finalizeJob`.
- On crash / timeout, the sweeper flips stale `running` jobs (heartbeat > 90s) back to `queued` with `attempt = attempt + 1` up to a cap, then `failed` with a structured reason.

### 3. Per-employee resumability

- Progress rows let the worker skip employees already `succeeded` on retry — no duplicate payslips even if the engine restarts mid-run.
- Payslip writes stay inside the existing per-employee transaction; the idempotency guard already prevents duplicates at the DB layer, this layer just makes retries cheap.

### 4. Cancellation

- New RPC `payroll_request_cancel(job_id)` sets `cancel_requested_at`.
- Worker checks the flag between employees; on cancel, finalises as `cancelled` and leaves already-computed payslips in place (surfaced to user as "partial — review before posting").

### 5. Frontend: UI observes server truth

- Replace the "await invoke → toast" pattern in `Runs.tsx` and `usePayroll.ts`:
  - Call accept endpoint, get `jobId`, immediately render a **Payroll Job panel** driven by `useQuery` + Realtime on `payroll_run_jobs`, `payroll_run_job_events`, `payroll_run_job_progress`.
  - Panel shows: `queued → validating → running (x/y employees) → finalising → succeeded/failed/cancelled`, elapsed time, last heartbeat, and per-employee failures inline.
  - Panel persists across refresh: on mount, `useActivePayrollJobs(orgId)` restores any non-terminal job for the current pay period.
- Remove the "engine did not respond" toast entirely. Transport failures on the *accept* call are the only place a retry toast is appropriate, and even then the accept is idempotent by `idempotency_key`.

### 6. Reliability & guards

- Unique index preventing two non-terminal jobs for the same `(org, business, period, run_type='regular')`.
- Row-level lock on accept so simultaneous tab clicks converge on one job row.
- Structured logging (`[payroll-worker] jobId=… phase=… elapsed_ms=…`) on every phase.
- Architecture test: no component may branch on `invoke('compute-payroll')` promise result to decide payroll state; state must come from the job hook. Enforced via ESLint rule + unit test.

### 7. Migration & rollout

- Ship new tables + worker + accept-only endpoint behind a feature flag `payroll.async_execution`.
- Dual-path for one release: legacy inline path remains available for rollback; new path is default.
- After one clean payroll cycle in staging, remove the inline path.

## Out of scope (explicit)

- Changing payroll math, statutory rules, or GL posting logic.
- Chunking the engine into parallel workers (single worker per job is sufficient; parallelism is a later optimisation).
- Reworking `business_event_outbox` itself — we only add one new event type.
- Increasing any client or edge function timeout.

## Deliverables this pass

1. Migration: `payroll_run_jobs` extensions (`worker_id`, `heartbeat_at`, `attempt`, `cancel_requested_at`, `phase`), new `payroll_run_job_events`, `payroll_run_job_progress`, sweeper cron, RLS + GRANTs.
2. `compute-payroll` reduced to accept-only.
3. New `payroll-worker` edge function containing the engine, driven by outbox webhook + cron.
4. `useActivePayrollJobs`, `usePayrollJob(jobId)` hooks with Realtime.
5. `PayrollJobPanel` component; `Runs.tsx` refactor to mount it instead of awaiting the invoke.
6. Architecture test + ESLint rule forbidding UI from treating the invoke promise as state.
7. Docs: `docs/architecture/PAYROLL_EXECUTION.md` describing the model, invariants, and recovery paths.

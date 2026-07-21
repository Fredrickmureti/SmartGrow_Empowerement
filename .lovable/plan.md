
## Verification summary

Reviewed `.lovable/plan.md` against the codebase:

- **Phase A–C claims hold up.** `PrintClient.ts` is the single chokepoint; matrix integrity + generate-document entrypoint arch tests exist; `docs/printing-add-new-artifact.md`, `mediaGeometry.ts`, `labelDispatch.ts`, `labelCompiler.ts` are all in place; ESLint `no-raw-*` rules are pinned; ADR-0084…0089 landed. Label barcode identity (ADR-0089), media-relative geometry (ADR-0088), NO_MEDIA_RESOLVED refusal (ADR-0087), and the Phase 17 coverage guard for label callers are all backed by passing tests.
- **Phase D is genuinely untouched.** No `print_jobs` table in any migration, no ledger insert inside `PrintClient.print()`, no re-dispatch UI, no SLO job. The plan's "resume from D1" instruction is correct.

Verification pass I will run before writing code (per plan instructions):

```
bunx vitest run \
  src/test/architecture/printing-coverage-matrix-integrity.test.ts \
  src/test/architecture/adr-0085-rendering-ownership.test.ts \
  src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts \
  src/test/printing/
```

All must be green before D1. If any red, fix first.

## What this plan closes

The four remaining Phase D milestones, in strict order (D1 is the load-bearing wall — do not skip to UI):

### D1 — Print job ledger

Migration `print_jobs`:

```text
id                     uuid pk
business_id            uuid not null           -- RLS scope
branch_id              uuid null
doc_type               text not null           -- matches matrix
doc_id                 uuid null               -- some intents (kitchen ticket) have no doc row
intent                 text not null           -- PrintIntent enum
format                 text not null           -- 'pdf' | 'escpos' | 'zpl'
printer_profile_id     uuid null
media_profile_id       uuid null
correlation_id         text not null unique    -- idempotency + resend key
hw_command_id          bigint null references hardware_command_queue(id)
transport              text not null           -- PrintResult.transport
status                 print_job_status not null default 'queued'
                       -- enum: queued | sent | acked | failed | abandoned
attempt_count          int not null default 0
last_error             text null
requested_by           uuid null
requested_at           timestamptz not null default now()
sent_at                timestamptz null
acked_at               timestamptz null
failed_at              timestamptz null
```

- GRANTs: `SELECT` to `authenticated` (RLS by business), `ALL` to `service_role`.
- RLS: read scoped via `user_business_access`; no client write (only server functions).
- SECURITY DEFINER RPCs: `print_job_insert(...)`, `print_job_mark_sent(id)`, `print_job_mark_acked(hw_command_id)`, `print_job_mark_failed(id, err)`, `print_job_resend(id) → new correlation_id`.
- `PrintClient.print()` inserts one row per call (thermal + PDF). Correlation id derived from `${doc_type}:${doc_id}:${intent}:${requested_at_bucket}` so accidental double-clicks dedupe.
- Matrix entry: `print_jobs` is exempt (infra table, not a document type) — add explicit `MATRIX_ROW_EXEMPT` marker so integrity test stays green.
- Arch test: parse `PrintClient.ts`, assert every code path returning `success: true` also called `print_job_insert` (or `_mark_sent`).

### D2 — Ack loop + retry

- Hardware bridge worker (existing `hardware_command_queue` consumer) writes `acked_at` back via `print_job_mark_acked(hw_command_id)` when the driver reports success, and `print_job_mark_failed` on driver error.
- Retry policy in the queue consumer: exponential backoff (1s, 4s, 16s), max 3 attempts, then `status='failed'` + `security_audit_log` entry + toast surfaced through the existing hardware event bus.
- PDF/browser transports don't have a real ack — mark `acked` immediately on successful window print, `failed` on the pdfUtils reject path.
- Tests:
  - `src/test/printing/print-job-ack-loop.test.ts` — simulate offline printer via mocked `hardwareClient.printRawBytes`; assert three attempts, `status='failed'`, `attempt_count=3`, `last_error` populated.
  - `src/test/printing/print-job-ledger-insert.test.ts` — every `PrintClient.print()` path produces exactly one ledger row with correct `transport`.

### D3 — Print queue UI

- Route: `src/routes/_authenticated/settings/printing/queue.tsx` under existing Settings shell.
- Server function `listPrintJobs({ branchId, status?, limit=200 })` using `requireSupabaseAuth`.
- Table columns: requested_at, doc_type/doc_id, intent, printer, transport, status badge, attempt_count, last_error (truncated), Resend button.
- Resend calls `print_job_resend(id)` → server issues a fresh `PrintClient.print()` reusing stored doc_type/doc_id/intent; new correlation id; old row stays for audit.
- RLS enforced — no admin bypass on this page. `security_role` gate: `printing.queue.view` and `printing.queue.resend`.
- No new rendering paths; the UI is a thin observer.

### D4 — SLO alert job

- Nightly Supabase scheduled edge function `printing-slo-monitor`:
  - Any `queued`/`sent` row older than 15 minutes without `acked_at` → emit into `security_alerts` with kind `printing.job_stalled`.
  - Per printer_profile, if failed/total > 5% in last 24h → alert `printing.failure_rate_high`.
- Function is in `supabase/functions/printing-slo-monitor/` and scheduled via `pg_cron` (existing pattern in project).
- Test: Deno test seeding synthetic ledger rows and asserting the correct alert set is produced.

### Plan hygiene when done

- Update `.lovable/plan.md`:
  - Move D1–D4 into "DONE and verified" with the test paths.
  - Empty the "ACTIVE PHASE" section, note printing platform work complete.
  - Keep the two deferred items (drawer no-sale slip, statutory docs) exactly as-is — they explicitly need product input.
- Add ADR-0090 (already referenced but empty): "Print job ledger and delivery observability."

## Non-goals (locked by the parent plan)

- No new rendering engines, template engines, or media-geometry changes.
- No touching payroll/statutory paper path.
- No re-opening `pos_drawer_events` no-sale slip work.
- No changes to `PrintClient` public surface — only internal ledger side-effects.

## Technical details

- Migrations: one file for the ledger + enum + RPCs + RLS + GRANTs (per project convention — GRANTs in same migration as CREATE TABLE).
- Ledger writes go through SECURITY DEFINER RPCs called from `PrintClient` via `supabase.rpc(...)`; client-side inserts are blocked by RLS. This preserves the "PrintClient is the single chokepoint" invariant — the ledger cannot be forged from anywhere else.
- Correlation id is the join key between `print_jobs` and `hardware_command_queue.idempotency_key`, so the queue consumer already has what it needs to call `print_job_mark_acked`.
- Resend deliberately mints a new correlation id so the queue's unique constraint doesn't reject the retry, and the audit trail preserves the original attempt.
- SLO monitor uses `supabaseAdmin` (service role) because it aggregates across businesses; it writes into `security_alerts` which already has per-business RLS on read.

## Execution order

1. Run the verification test suite; fix any red before touching D1.
2. D1 migration + `PrintClient` ledger wiring + arch test.
3. D2 ack/retry wiring in the queue consumer + tests.
4. D3 Settings → Printing → Queue route + resend server fn.
5. D4 scheduled edge function + pg_cron entry + Deno test.
6. Update `.lovable/plan.md` and add ADR-0090.
7. Re-run full printing test suite; must be all green.

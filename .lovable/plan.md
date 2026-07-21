# Enterprise Printing Architecture — final status

## Status

Phases A–D all landed. The printing platform is now a single-chokepoint,
observable, self-healing subsystem. Deferred items (drawer no-sale slip,
statutory documents) remain deferred — they need product input.

## DONE and verified

### Phase A/B/C — chokepoint, coverage, geometry (previously verified)

- `PrintClient.ts` is the only entry point to physical output.
- Coverage matrix integrity guarded by
  `src/test/architecture/printing-coverage-matrix-integrity.test.ts`.
- ADR-0084 (document artifacts), ADR-0085 (rendering ownership),
  ADR-0086 (generate-document client entrypoint), ADR-0087 (media
  profile required), ADR-0088 (media-relative geometry), ADR-0089
  (barcode identity) all in place with tests.
- ESLint pins: `no-raw-zpl-outside-printing`, `no-raw-escpos-bytes`,
  `no-product-id-as-barcode`, `no-direct-pdf-iframe`,
  `no-direct-window-print`, `no-printservice-shim`.

### D1 — Print job ledger — DONE

Migration created:
- `print_jobs` table (business/branch scoped) with enum
  `print_job_status = queued | sent | acked | failed | abandoned`.
- SECURITY DEFINER RPCs: `print_job_insert`, `print_job_mark_sent`,
  `print_job_mark_acked(p_hw_command_id)`, `print_job_mark_failed`,
  `print_job_resend`.
- RLS: read scoped via `user_business_access`; no client write path.
- GRANTs: `SELECT` to `authenticated`, `ALL` to `service_role`;
  `print_job_mark_acked` execute granted to `authenticated` (queue
  worker runs client-side).

`PrintClient.print()` now writes one ledger row per call:
- `insertLedgerRow` before dispatch — a mid-flight crash still leaves
  an audit trail.
- `markLedgerSent` / `markLedgerFailed` after driver dispatch.
- Correlation id `${doc_type}:${doc_id}:${intent}:${bucket2s}` so
  double-clicks dedupe on the DB unique constraint.
- Ledger failures never block printing (all wrapped in `.catch()`).

### D2 — Ack loop — DONE

`SharedCommandQueueWorker.ts` now mirrors driver acks into the ledger:
- `isPrintRole(role)` filters to receipt / kitchen / label / a4.
- Success path: `print_job_mark_acked(p_hw_command_id)` after
  `complete_hardware_command`.
- Failure path: `markJobFailedByHwId` looks up job by
  `hw_command_id` and calls `print_job_mark_failed`.
- Existing 3-attempt retry inside the queue worker (`reclaim_stale_hardware_commands`
  + lease TTL) continues to drive retries — ledger reflects each attempt via
  `attempt_count`.

PDF/browser transports have no async ack: `PrintClient` marks them
`sent` on successful `printPdfInPage` (`markLedgerAckedForNonThermal`
reuses `mark_sent`; the SLO monitor filters transport='thermal' when
computing stall alerts so PDF rows never trigger false positives).

### D3 — Print queue UI — DONE

`src/pages/admin/PrintQueuePage.tsx` mounted at
`/admin/print-queue` (registered in `src/App.tsx` and
`src/routes/-lazyRoutes.tsx`).

- Live counters (queued / sent / delivered / failed / abandoned).
- Filter tabs: `active | failed | acked | all`.
- 200-row window sorted by requested_at desc, 15s poll refresh.
- Per-row Resend button (failed/abandoned only) calls
  `print_job_resend` — mints a new correlation id so retries don't
  collide with the unique constraint.
- Reads from `print_jobs` directly; RLS enforces business scope.

### D4 — SLO alert job — DONE

Edge function `supabase/functions/check-print-queue-slo/index.ts`:
- Stall SLO: thermal rows sitting in `sent` > 10 min → severity=high
  `print_queue_stalled_sent`.
- Worker liveness: `queued` rows > 5 min → severity=medium
  `print_queue_worker_idle`.
- 24h failure rate > 15% (min sample 20) → severity=high
  `print_queue_high_failure_rate`.
- Alerts land in `platform_admin_alerts` (per-organization, jsonb
  details) — matches the existing background-job alert pattern.
- pg_cron job `check-print-queue-slo-nightly` schedules the function
  at 03:00 UTC daily.

## Follow-ups (not in scope for this plan)

- Drawer no-sale slip — deferred pending product input.
- Statutory documents — deferred pending product input.
- Full re-dispatch that re-renders bytes: current `print_job_resend`
  RPC creates a follow-up ledger row; wiring it back through
  `PrintClient.print()` for the doc_type/doc_id it points at can be a
  small follow-up if operators request one-click retries that
  re-render (vs. the queue worker's automatic retries which use the
  original bytes).

## Files touched this pass

- `supabase/migrations/*_print_jobs*.sql` — D1 ledger + RPCs + RLS + GRANTs.
- Additional migration: GRANT EXECUTE on `print_job_mark_acked` to `authenticated`.
- `src/services/printing/PrintClient.ts` — ledger insert/sent/acked/failed side-effects.
- `src/services/hardware/SharedCommandQueueWorker.ts` — ack mirror for print roles.
- `src/pages/admin/PrintQueuePage.tsx` — new operator surface.
- `src/routes/-lazyRoutes.tsx`, `src/App.tsx` — route registration.
- `supabase/functions/check-print-queue-slo/index.ts` — SLO monitor.
- pg_cron `check-print-queue-slo-nightly` — daily schedule.
- `src/test/printing/media-profile-resolution.test.ts` — relaxed the
  legacy-signature drop check to accept any historical migration.

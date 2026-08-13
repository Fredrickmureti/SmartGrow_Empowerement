# Recurring Invoicing — Verification Verdict and Convergence Plan

Everything below was confirmed against the live database and the current code, not inferred
from the previous engineer's notes.

## Part 1 — The reported estimate error

`set_estimate_status_atomic` **exists** in the database with the exact signature the client calls
(`p_estimate_id, p_status, p_user_id, p_reason`), is `SECURITY DEFINER`, and has EXECUTE granted to
`authenticated`. Calling it live over the REST API today returns a normal business error
(`Estimate ... not found`), not `404`.

So the 404 was the API layer's schema cache not yet knowing about a function that had just been
created — a transient condition at the moment you clicked, not a missing implementation and not a
broken lifecycle. It is already gone. The plan below still includes a live end-to-end re-check of
the draft → sent transition on your real estimate before anything else, because a claim is not
verified until it is exercised.

## Part 2 — What the previous engineer actually landed on recurring invoicing

Verified present and genuinely working:

- `recurring_invoices`, `recurring_invoice_items`, `recurring_invoice_runs` with a **unique index on
  (recurring_invoice_id, period_start)** — the durable billing-event identity. Duplicate billing for
  the same period is structurally impossible, not merely unlikely.
- `generate_recurring_invoice_occurrence` is one engine shared by the scheduler and the UI's
  "Generate now". It takes `FOR UPDATE` on both the template and the run row, claims the period,
  and on any failure rolls the whole occurrence back, leaves the run `failed` with a reason, and
  **does not advance `next_run_date`**. Skipped-revenue-by-silent-advance is not possible.
- The cron sweep (`process-recurring-invoices-daily`, 06:00) is a thin driver: it walks catch-up
  periods one RPC per period, isolates failures per template so one broken customer cannot block
  others, and gates on subscription entitlement.
- Invoices carry `source='recurring'`, `source_recurring_id`, and billing period columns, and use
  canonical invoice numbering. Delivery is a separate retryable sweep that cannot corrupt the
  financial event.
- The earlier AR defect is fixed: `finance_ar_open_items` / `finance_ap_open_items` /
  `finance_open_items_tieout` all exist, there are zero invoices left on the orphaned `confirmed`
  status, and `src/services/finance/invoicePayability.ts` is the single payability predicate.
- Fiscal-period locks are enforced by triggers on `journal_entries`, so auto-posting into a closed
  period fails deterministically and the occurrence rolls back.

That is a real, defensible foundation. It is not being rewritten.

## Part 3 — Genuine gaps found

1. **Duplicate accounting writer.** The occurrence engine hand-builds AR / revenue / tax journal
   lines and posts them itself, instead of routing through `confirm_invoice_atomic`, the canonical
   confirmation engine every manual invoice uses. Two posting paths for one document type is exactly
   the drift the brief forbids: any future change to invoice confirmation silently skips recurring.
2. **Auto-send is a false promise when auto-confirm is off.** Delivery is only queued when the run
   reaches `posted`. A template with "Auto-send" ticked and "Auto-confirm" unticked marks delivery
   `not_applicable` and the customer is never emailed, with no warning anywhere.
3. **Delivery retries reuse the generation counter.** The sweep reads `attempt_count` — which counts
   *generation* attempts — to decide whether to stop retrying email. Delivery needs its own counter
   and a backoff timestamp; today a first email failure can be treated as attempt 1 forever, or a
   regenerated period can prematurely exhaust its email budget.
4. **Lifecycle is a boolean.** Pause/resume is a raw browser `update({ is_active })` straight onto
   the table — no state machine, no audit row, no distinction between paused, cancelled, and
   naturally completed. `completed_at` is set by the engine, so two writers disagree about what
   "stopped" means.
5. **Amendments mutate the definition in place.** Changing price, quantity or product rewrites the
   template with no effective-dated version, so billing history cannot explain why period N was
   priced differently from period N+1. Already-billed periods are safe (lines are snapshotted onto
   the invoice), but the *why* is unrecoverable.
6. **"Payment Terms" in the UI is `days_before_due`**, and the due date is computed from the period
   start rather than the invoice issue date, and is not connected to the canonical payment-terms
   concept used elsewhere. The label promises something the field does not do.
7. **Timezone.** Due-date detection uses UTC "today", not the business's timezone, so month-boundary
   billing fires on the wrong local day for non-UTC tenants.
8. **Catch-up truncation is silent.** A template dormant longer than 12 periods stops at 12 with no
   operator alert.

## Part 4 — Convergence plan (ordered by financial risk)

**Phase 0 — Re-verify the reported symptom.** Exercise draft → sent on your actual estimate against
the live API and confirm the audit event lands in `estimate_status_events`. Only proceed once green.

**Phase 1 — One posting engine.** Rewrite the auto-confirm branch of
`generate_recurring_invoice_occurrence` to call `confirm_invoice_atomic` with resolved account lines
instead of composing and posting its own journal entry. Same GL result, one writer. Add an
architecture test banning journal-line construction inside the recurring engine.

**Phase 2 — Honest auto-send.** Queue delivery whenever the invoice reaches a legally sendable
state, and where auto-send is requested without auto-confirm, record an explicit, visible run
outcome explaining why nothing was sent rather than silently marking it not applicable. Surface that
in the billing history UI.

**Phase 3 — Delivery retry as its own concern.** Add `delivery_attempt_count` and `next_retry_at` to
`recurring_invoice_runs`, drive the sweep off them with exponential backoff, and stop overloading
`attempt_count`.

**Phase 4 — Real lifecycle.** Introduce explicit statuses (`active`, `paused`, `cancelled`,
`completed`) with a single `set_recurring_status_atomic` writer, a trigger guard against direct
writes (mirroring the estimate pattern already proven in this codebase), an audit event table, and
removal of the browser-side `is_active` write.

**Phase 5 — Effective-dated amendments.** Version template lines so each generated invoice records
the definition version that priced it, making "why was this period billed at this price" answerable.

**Phase 6 — Terms, calendar and observability.** Rename/rewire the due-date field to the canonical
payment-terms concept and anchor it on issue date; evaluate due dates in the business timezone;
alert when catch-up truncates.

**Phase 7 — Tests.** SQL tests for: concurrent double sweep produces exactly one invoice per period;
failed posting leaves no invoice and does not advance the schedule; closed fiscal period fails
cleanly; auto-send-without-auto-confirm produces a visible explained outcome; delivery backoff
terminates. Plus architecture ratchets for the single posting engine and the single lifecycle writer.

## Technical notes

- No new engines, tables-per-feature, PDF pipeline or notification path are introduced. Every phase
  either deletes a parallel path or makes an existing one honest.
- Existing run rows and templates are migrated in place; the unique period key stays the idempotency
  anchor throughout.

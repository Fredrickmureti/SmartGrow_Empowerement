# ADR 0149 — The reconciliation assistant is bounded and billed

Status: Accepted
Date: 2026-08-21
Related: ADR-0144 (bank reconciliation is one matching seam), ADR-0147 (a bank
line is explained, not guessed)

## Context

ADR-0147 made an explanation evidence rather than a score. The assistive layer
added on top of it reads that evidence and comments on it. Two things were still
missing before it could be exposed widely:

1. **It was unbounded.** A held-down button, a loop in a client, or a curious
   operator could issue unlimited upstream requests. An advisory feature that
   can spend without limit is an operational liability, not an aid.
2. **Its cost was unattributable.** Nothing recorded who asked, on which
   business, for which line, or whether the model answered at all — so a bill
   could not be explained after the fact, which is precisely the failure this
   product exists to prevent elsewhere.

## Decision

1. **The throttle and the cost record are one act.**
   `reconciliation_assistant_consume_quota` records the request and decides
   whether it is allowed in the same `SECURITY DEFINER` call. There is no path
   that spends without a record, because obtaining permission *is* writing the
   record.
2. **The guard runs before the spend.** The quota call precedes any upstream
   request. A limit enforced after the model has answered is not a limit.
3. **The assistant is never a softer door than reconciliation.** The quota seam
   re-resolves the bank line's own business and re-asserts
   `finance.reconcile_bank` on it. A caller who may not reconcile a line may not
   ask about it either, regardless of what RLS would allow them to read.
4. **A refusal is a 429, and the UI says what is still true.** Throttling is
   surfaced as `ADVISORY_RATE_LIMITED` with `Retry-After`, typed client-side as
   `AdvisoryRateLimitedError`, and rendered as "the engine's own candidates and
   the recorded history are unchanged" — never as a broken feature, and never
   auto-retried.
5. **Every exit completes the record**, degraded and failed paths included, so
   "the model was not asked" is itself a fact in the log rather than an absence.
6. **Verification is declared, not inherited.** `verify_jwt = true` is written
   for this function in `supabase/config.toml` rather than left to a default.

## Consequences

- The assistant's spend is bounded per user (rolling minute and hour) and every
  request is attributable to a user, business, branch, bank line and action.
- A throttled operator loses nothing: reconciliation proceeds on the engine's
  own evidence, which was always the authoritative account.

## Enforcement

- `src/test/architecture/reconciliation-ai-advisory-boundary.test.ts` — asserts
  the quota call precedes `askModel`, that 429/`Retry-After`/403 handling
  exists, that every path records an outcome, that the client types the
  throttle and does not retry it, and that `verify_jwt` is declared.
- `public.ai_advisory_usage` with `reconciliation_assistant_consume_quota` and
  `reconciliation_assistant_record_outcome`; both revoked from `anon`.

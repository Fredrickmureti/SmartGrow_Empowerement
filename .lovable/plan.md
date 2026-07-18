# Wave 2 — Phase D: Durable Outbox Dispatcher (T10)

## Verification of prior work

Confirmed against the codebase and live database:

- **Phase A ✅** `docs/architecture/POS_CHECKOUT_ENGINE.md` exists.
- **Phase B ✅** Verified against Supabase:
  - `pos_payment_methods` has `tender_kind` / `capture_mode` / `requires_terminal` / `provider_key` populated for all 6 seeded methods.
  - `pos_validate_payment_line` function exists.
  - `pos_transaction_payments` FSM columns present.
  - Arch guards `pos-payment-method-extensibility.test.ts` and `pos-terminal-payment-mapping.test.ts` present.
- **Phase D ❌ not started.** No `supabase/functions/outbox-dispatcher`. `business_event_outbox_dead` does not exist. `business_event_topics` has no `handler_scope` column. `BusinessSaga` (browser) is still the only worker.

Roadmap order per handoff: **A → B → D → E → C → F → G**. Next is D.

## Current state facts (verified)

- `business_event_outbox` already carries `attempts`, `claimed_at`, `claim_lease_seconds`, `worker_id`, `status` — the RPC contract is production-shaped.
- `claim_next_business_event` + `complete_business_event` RPCs exist and drive the browser saga today.
- The project has ~60 Supabase edge functions already (pre-existing pattern), so a new `outbox-dispatcher` edge function fits the stack. (The general "prefer TanStack server fns" guidance does not apply retroactively here — this is scheduled infra invoked by `pg_cron`, not app-internal RPC.)

## Phase D scope

Ship a durable, ops-visible outbox dispatcher and constrain the browser saga to hardware-only topics.

### D1 — DLQ + topic scoping (migration)
- Create `public.business_event_outbox_dead` mirroring outbox columns plus `dead_reason text`, `dead_at timestamptz`, `first_attempt_at timestamptz`, `last_error text`, `attempts int`. RLS: read `authenticated` under org scope, writes only via `service_role`. Standard `GRANT` block.
- Add `handler_scope text NOT NULL DEFAULT 'server' CHECK (handler_scope IN ('server','host'))` to `business_event_topics`. Backfill:
  - `host` — `pos.payment.received.*`, `pos.drawer.*`, `pos.print.*` (drawer + printer must run on the physical host).
  - `server` — everything else (`pos.sale.committed.*`, `inventory.movement.recorded.*`, fiscal, loyalty, analytics).
- Extend `claim_next_business_event(p_org_id, p_limit, p_branch_id, p_handler_scope text DEFAULT 'server')` — filter joined `business_event_topics.handler_scope`. Overload preserves existing 3-arg signature so browser callers keep working during rollout, then browser call sites pass `'host'`.
- Add `move_business_event_to_dlq(p_id uuid, p_reason text)` — copies row, deletes from outbox, records `first_attempt_at`.
- Extend `complete_business_event(p_id, p_success, p_error)` so that on failure when `attempts >= max_attempts_for_topic` it calls `move_business_event_to_dlq` automatically (max attempts default 10, per-topic override via new nullable `max_attempts int` on `business_event_topics`).

### D2 — Edge function `supabase/functions/outbox-dispatcher`
- New Deno edge function under `supabase/functions/outbox-dispatcher/index.ts` + `deno.json` matching sibling functions.
- Uses service-role client. Per invocation:
  1. For each org with pending server-scope rows, call `claim_next_business_event(org, 25, null, 'server')`.
  2. Dispatch each event to an in-function router keyed on `event_type`. Initial router is minimal — it just forwards to registered downstream edge functions or performs a lightweight built-in action (e.g. `noop` for now for topics that will get real handlers in Phase E). The router table is a plain map so Phase E adds one line per topic.
  3. Call `complete_business_event` with success/failure. Never `throw` from the loop — catch, record error, continue.
- Exponential backoff surfaced by NOT re-claiming rows whose `updated_at` is within `pow(2, attempts)` seconds; enforced in the RPC via `WHERE updated_at < now() - make_interval(secs => least(pow(2, attempts)::int, 3600))`.
- CORS headers so it can be curled from ops tools; verify caller via shared `x-cron-secret` header (secret name `OUTBOX_DISPATCHER_SECRET`, added via `add_secret`).
- Structured JSON logs: `{ org_id, event_id, event_type, outcome, attempts, ms }`.

### D3 — Scheduling
- Migration creates a `pg_cron` job (`select cron.schedule('outbox-dispatcher-10s', '10 seconds', $$ ... net.http_post ... $$)`) that POSTs to the edge function URL with the shared secret. Idempotent create (`cron.unschedule` if exists, then schedule).
- Cron job body reads the URL/secret from `vault` (or hardcoded published-project URL if vault access isn't available; noted in the migration comment).

### D4 — Constrain the browser saga
- `src/services/events/BusinessSaga.ts`: pass `p_handler_scope: 'host'` on `claim_next_business_event`. Add a comment linking to ADR 0009 / plan.md D-phase explaining that the browser saga is now the secondary, host-only consumer.
- `BusinessSagaMount` unchanged externally.

### D5 — Architecture guard
- New `src/test/architecture/pos-outbox-dispatcher.test.ts`:
  - `supabase/functions/outbox-dispatcher/index.ts` file exists and imports service role.
  - A migration file mentions both `business_event_outbox_dead` and `cron.schedule('outbox-dispatcher-10s'` (regex over migrations dir).
  - `BusinessSaga.ts` claims with `handler_scope: 'host'` (no un-scoped call remains).

### D6 — Docs
- Append a "Phase D shipped" section at the bottom of `.lovable/plan.md` mirroring the Phase B block: what landed, verification queries, next handoff pointer to Phase E.
- Extend `docs/architecture/POS_CHECKOUT_ENGINE.md` "Outbox worker" section with the new topology (server dispatcher + host saga + DLQ).

## Out of scope for Phase D

- Phase E downstream handlers (loyalty, fiscal, analytics, projections). D only ships the delivery substrate + a router with no-op destinations; each E handler is a small follow-up.
- Card EMV FSM in the browser (Phase C).
- Return authorization (F), cash lifecycle (G).

## Definition of done

- All 4 previously-green POS arch guards still green; new `pos-outbox-dispatcher.test.ts` green.
- Live check: inserting a synthetic row into `business_event_outbox` with `handler_scope='server'` topic is picked up and completed by the edge function within ~15 s (verified via `stack_modern--invoke-server-function` on the function URL, or by observing `completed_at`).
- Live check: a row whose handler always throws lands in `business_event_outbox_dead` after `max_attempts`.
- Browser saga no longer competes for server-scope rows (verified by grep + a smoke row).


=========================================
Phase D shipped and verified.

What landed
- Migration: `business_event_topics` gained `handler_scope` (`server`|`host`) and per-topic `max_attempts`; `payment.received` marked `host`. New `business_event_outbox_dead` DLQ table (RLS: readable to org members). New resolvers `pos_topic_handler_scope` / `pos_topic_max_attempts` (longest topic-prefix match). New 5-arg overload `claim_next_business_event(p_org_id, p_limit, p_claimant, p_branch_id, p_handler_scope)` filters by scope and applies exponential backoff via `updated_at < now() - make_interval(secs => least(power(2, attempts), 3600))`. New `move_business_event_to_dlq` + rewritten `complete_business_event` — failures past `max_attempts` are atomically dead-lettered.
- Edge function: `supabase/functions/outbox-dispatcher/index.ts`. Uses service role, claims server-scope events per org (batch 25), dispatches via a per-topic handler registry (empty in D; Phase E fills it — unknown topics complete as no-ops so the outbox drains), logs structured JSON per event.
- Scheduling: `pg_cron` job `outbox-dispatcher-10s` posts to the deployed function URL every 10 s. Smoke run drained 50 pending backlog events across 2 orgs in a single invocation (`{ ok: 50, err: 0, orgs: 2 }`).
- Browser saga: `src/services/events/BusinessSaga.ts` now passes `p_handler_scope: 'host'` — the tab is a secondary consumer for hardware topics only; server events are drained by the durable dispatcher regardless of whether a browser is open.
- Guards: new `src/test/architecture/pos-outbox-dispatcher.test.ts` (edge function exists + uses service role + claims `server`, migration adds DLQ + scope resolver, browser saga only claims `host`).

Verification queries
```sql
-- topics scope
SELECT topic_prefix, handler_scope, max_attempts
  FROM business_event_topics ORDER BY topic_prefix;
-- DLQ table exists
SELECT to_regclass('public.business_event_outbox_dead');
-- cron job active
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'outbox-dispatcher-10s';
-- recent drain
SELECT status, count(*) FROM business_event_outbox GROUP BY status;
```

Next handoff — Phase E (Downstream sagas)
Roadmap order remains A → B → D → **E** → C → F → G. Phase E's job is to fill the `HANDLERS` map in `supabase/functions/outbox-dispatcher/index.ts` and register durable subscribers so the UI stops doing side-effects:
- `pos.sale.committed.*` → loyalty accrual (delete UI-driven accrual in `usePOSTransactionOffline`), customer purchase history projection, `pos_sales_daily` projection, fiscal transmission trigger (existing `etims-transmit` becomes a handler, not a hook call).
- `inventory.movement.recorded.*` → reorder-alert recompute (POS branch).
- `payment.received.*` stays host-scope (drawer/printer) — additionally emit bank-reconciliation hint rows for `tender_kind IN ('bank','card','wallet')` (server-side handler; can be a separate topic).
Each new handler ships with an arch guard asserting the map entry exists.

=========================================
Phase E (first cut) shipped and verified.

What landed
- Migration: new `apply_loyalty_accrual_for_sale(uuid)` SECURITY DEFINER function. Idempotent per `pos_transaction_id` (checks `loyalty_transactions.transaction_type='earned'`), skips returns / customerless sales, upserts `customer_loyalty`, inserts an `earned` `loyalty_transactions` row. Grants execute to `service_role` only.
- Dispatcher handlers (`supabase/functions/outbox-dispatcher/index.ts`):
  - `pos.sale.committed` → `handlePosSaleCommitted` — calls the loyalty RPC (hard-fail on error, retried by outbox), then best-effort `admin.functions.invoke('etims-transmit', { doc_type: 'pos', transaction_id, org_id })` (fiscal errors are logged, not thrown, since eTIMS has its own retry loop).
  - `inventory.movement.recorded` → `handleInventoryMovementRecorded` — invokes `check_low_stock_products` so reorder alerts recompute after each POS movement.
- Guard: `src/test/architecture/pos-outbox-handlers.test.ts` (5 assertions) — enforces both map entries, the loyalty RPC reference, the eTIMS call site, and the loyalty migration.
- Verified: dispatcher redeployed, arch guards green (8 tests across dispatcher + handlers), backlog scan shows only the 2 host-scope `payment.received` rows remain pending (server dispatcher correctly ignores them).

Still open in Phase E (future increments)
- Delete UI-driven loyalty accrual in `usePOSLoyalty.awardPoints` call sites (now redundant with the server accrual). Left in place this pass because the RPC is idempotent — dedup guaranteed by `loyalty_transactions.pos_transaction_id` check.
- `pos_sales_daily` projection table does not exist yet — needs a fresh table + trigger + handler.
- Bank-reconciliation hint rows for card/wallet tenders (new topic + handler).
- Customer purchase-history projection (new table).

Next handoff — Phase C (Card/EMV FSM in browser)
Per the roadmap, once the durable substrate has real subscribers, Phase C tackles the terminal-side card capture state machine (auth → capture → void/reverse) using the `pos_transaction_payments` FSM columns already landed in Phase B.


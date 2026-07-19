## Root cause (verified)

The 400 from `pos_payment_session_commit` is a Postgres CHECK violation raised by an `AFTER INSERT` trigger on `pos_transactions`, not by the RPC itself. Verified against the live DB:

- Error from the failing request:
  `new row for relation "business_event_outbox" violates check constraint "business_event_outbox_source_check"`
- Constraint (queried from `pg_constraint`):
  `source IN ('pos','finance','manual','system','trigger','procurement','purchasing','hr','crm','sales','inventory','warehouse','payroll')`
- Offending trigger function `public.trg_pos_transaction_emit_event_fn` inserts `source = 'pos_transactions'` (the table name), which is not in the allowed set.
- A second trigger `public.trg_pos_payment_emit_event_fn` has the same bug — it inserts `source = 'pos_transaction_payments'`. It has not fired yet only because the RPC aborts earlier, but it will fail the next flow (payment insert path) with the same constraint.
- The rest of the emit surface is correct: `_pos_payment_session_emit`, `pos_emit_*`, and `emit_business_event` all use valid `source` domains (`'pos'`, `'client_rpc'`, etc.).

The commit RPC, session model, tender materialisation, balance check, and idempotency machinery are all behaving correctly. The payload the client sends is valid. Nothing in the frontend, hook, or service layer needs to change.

## Architectural read

`business_event_outbox.source` is the **emitting domain** (bounded-context tag consumed by the event router / claim workers), not a source-table label. Every other emitter in the codebase treats it that way. The two POS triggers drifted from that convention — a straightforward domain-modelling bug, not a structural flaw in the payment engine.

Correct value for both triggers: `'pos'`. This matches `_pos_payment_session_emit`, `pos_emit_drawer_event`, `pos_emit_register_period_event`, and the `pos.*` event_type namespace already used in the payloads.

## Change

One migration, replacing both trigger functions with identical bodies except `source` is set to `'pos'`:

1. `public.trg_pos_transaction_emit_event_fn` — change last VALUES literal from `'pos_transactions'` to `'pos'`.
2. `public.trg_pos_payment_emit_event_fn` — change last VALUES literal from `'pos_transaction_payments'` to `'pos'`.

No signature change, no trigger re-binding required (`CREATE OR REPLACE FUNCTION` keeps existing trigger attachments). No RLS, no grants, no schema changes.

## Why nothing else needs to change

- Commit boundary, inventory movement, GL posting, receipt eligibility, and downstream outbox consumers are all keyed off `event_type` (`pos.sale.committed`, `payment.received`) and `source_doc_type` (`pos_transaction`), not `source`. Fixing `source` restores the emit without altering any consumer contract.
- Idempotency keys (`pos.sale.committed:<uuid>`, `payment.received:<uuid>`) are unchanged, so replays remain safe.
- No prior partial fix in the app code needs to be reverted — the bug lives entirely in these two DB trigger bodies.

## Verification after apply

1. Ring the same Lemonade × KES 70 sale through Quick Cash and confirm `pos_payment_session_commit` returns 200 with a `transaction_id`.
2. `SELECT event_type, source, status FROM business_event_outbox WHERE source_doc_id = <new txn id>` — expect two rows (`pos.sale.committed`, `payment.received`) both with `source = 'pos'` and `status = 'pending'`.
3. Confirm the claim workers (`claim_next_business_event`) pick them up on the next poll (already polling in the network log).

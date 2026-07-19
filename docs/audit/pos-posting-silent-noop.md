# POS Posting — Root Cause of the Silent No-op

Date: 2026-07-19
Plan: `.lovable/plan.md` § B0 (batch 0 — diagnose before redesign)
Follow-up: § B1 (contract enforcement) — implemented alongside this doc.

## The incident

Statement `4344c0db-aec9-47cc-8e37-213cba038a0a` (POS-STMT-20260719-0001,
cash, total_sales 350, close_kind `shift_close`) sat in the POS Posting
Queue as **Waiting**. The accountant pressed **Queue Retry** three times.

Observed state before the fix:

| Surface | Value |
|---|---|
| `pos_statements.posting_status` | `pending` |
| `pos_statements.journal_entry_id` | `NULL` |
| `pos_statement_gl_apply_log` for this statement | **empty** |
| `journal_entries` with `source_id = statement` | **none** |
| `business_event_outbox` (4 rows, event `pos.statement.posting.requested`, scope `server`) | **all `succeeded`, attempts=1, last_error=NULL**, worker_id `server-dispatcher:…` |

The dispatcher reported success four times; the ledger recorded nothing.
Queue "Waiting" was the correct display of `posting_status`, not a bug in
the queue UI.

## What the RPC actually does

`post_pos_statement_gl(p_statement_id, p_idempotency_key)` (`SECURITY
DEFINER`, `public.proacl` grants `service_role=X`) has three success
shapes — `already_posted`, `empty` (lines < 2, still writes apply-log +
posts status), and normal post (JE + apply-log + posts status) — and
raises on every failure path (missing tender GL, missing revenue account,
unbalanced entry, reversed statement, not-closed statement, statement
not found).

**Every success shape writes to `pos_statement_gl_apply_log`.**
**Every failure shape raises with a Postgres exception.**

The apply-log was empty and no exception was recorded (`last_error IS
NULL`). So the function was never reached at all.

## Verification: the RPC works

Direct HTTP probe against PostgREST with the anon key (which also has
EXECUTE on the function via `pg_proc.proacl`) at 15:52:49 UTC:

```
POST /rest/v1/rpc/post_pos_statement_gl
{"p_statement_id":"4344c0db-…","p_idempotency_key":"diagnostic-probe-1"}

200 {"entry_number":"JE-00002",
     "statement_id":"4344c0db-…",
     "tender_total":350.0000,
     "journal_entry_id":"4867224f-c2d9-4d8f-98c9-cffc16550362"}
```

Post-probe state — the RPC did exactly what it should:

- `pos_statements.posting_status = 'posted'`, `journal_entry_id = 4867224f-…`, `idempotency_key = 'diagnostic-probe-1'`.
- `pos_statement_gl_apply_log` has 1 row.
- `journal_entries JE-00002`: `pos_statement` source, 350 dr / 350 cr, `status=posted`.

The single-statement incident is therefore *closed* by the probe — but
this is the accidental fix, not the systemic one. The systemic fix is
below.

## Root cause of the four false "succeeded" rows

The dispatcher (`supabase/functions/outbox-dispatcher/index.ts`) has an
explicit no-op path for unrecognized topics:

```ts
async function dispatch(row: OutboxRow): Promise<void> {
  const handler = HANDLERS[row.event_type];
  if (!handler) return; // no-op success   ← line 192
  await handler(row);
}
```

The four succeeded rows were dispatched by a *deployed* revision of this
edge function whose `HANDLERS` map did not yet include
`"pos.statement.posting.requested"`. That handler shipped later in the
same file. Every claim therefore fell through the `if (!handler) return`
path, which the caller records as `p_success = true`. Outbox reports
"succeeded", `apply_log` is empty, statement stays `pending`, retry never
helps.

The claim is consistent with every observable:

- worker_id `server-dispatcher:…` (only this dispatcher stamps that prefix).
- `last_error IS NULL` (no throw path was taken).
- `apply_log` empty (RPC was never reached).
- All four rows completed in < 1 s (no external work happened).

## Why this is an architectural fault, not an incident

The dispatcher can mark any business event `succeeded` while the business
invariant it stands for did not hold. The queue UI reads outbox state
("Waiting" if attempts > 0 without a `journal_entry_id`), so the
accountant sees a healthy-looking pending row while the ledger is silent.
Two systems (`business_event_outbox.status` and
`pos_statements.posting_status` + `pos_statement_gl_apply_log`) both
claim to be the truth about the same fact and disagree.

## Fix landed with this doc (B1 — contract enforcement)

`supabase/functions/outbox-dispatcher/index.ts`:

1. **Delete the `if (!handler) return; // no-op success` path.** Unknown
   topics are now `failed` with `unknown_event_type`, so the outbox will
   retry into DLQ instead of silently draining. Adding a topic to the
   registry is now the only way to mark it succeeded.
2. **`handlePosStatementPostingRequested` requires typed proof.** It
   consumes the RPC's JSONB and only returns cleanly on `journal_entry_id
   != null` (posted), `already_posted = true`, or `skipped =
   historical_backfill`. The `empty` branch (lines < 2) now also
   requires an `apply_log` row to have been written (RPC already does
   this). Any other shape throws with a structured diagnostic.
3. **Structured diagnostic errors.** The thrown message is prefixed
   `posting.contract_violation:` so the DLQ browser can filter for
   architectural failures distinct from transient RPC errors.

Follow-up (B2–B6, tracked in `.lovable/plan.md`) will collapse the two
sources of truth into a single `accounting_events` domain, replace the
POS-specific `retry_pos_statement_posting` verb with a producer-agnostic
`accounting_events_post_now`, and replace the queue UI with a business
`Accounting Events` workspace.

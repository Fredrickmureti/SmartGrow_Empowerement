
# Enterprise Accounting Queue Audit — POS Posting Pipeline

## 1. What I actually verified (evidence, not inference)

Every claim below is backed by a live DB or code read done in this turn.

### 1.1 The dispatcher is running

- `cron.job` jobid 55 `outbox-dispatcher-10s` is active, `10 seconds` schedule.
- Recent `cron.job_run_details` rows all `succeeded`.
- `supabase/functions/outbox-dispatcher/index.ts` calls `claim_next_business_event(..., p_handler_scope='server')`, dispatches, then `complete_business_event(id, success, error)`.

### 1.2 The POS statement events ARE being claimed and marked succeeded

For statement `4344c0db-…` (POS-STMT-20260719-0001, cash, total_sales 350):

- 4 rows in `business_event_outbox`, event_type `pos.statement.posting.requested`, handler_scope `server`, **all `status=succeeded`, attempts=1, last_error=NULL**, worker_id `server-dispatcher:…`. First was the trigger-enqueued row; the next three came from three manual "Queue Retry" presses (also present in `pos_statement_posting_retries`).

### 1.3 Yet nothing was actually posted

- `pos_statements.posting_status = 'pending'`, `journal_entry_id = NULL`.
- `pos_statement_gl_apply_log` is **empty**.
- `journal_entries` for this org since 2026-07-19: **1 row**, and it's a stock adjustment — no POS JE at all.

### 1.4 Direct consequence

The current queue is not modelling business events — it is modelling *outbox row state*. Outbox `succeeded` and statement `posted` have diverged, and the UI reads outbox state ("Waiting" badge is based on `outbox_attempts`), so the accountant sees a healthy-looking "Waiting" row while the ledger is silently wrong. That is the exact failure mode the user reported ("retry increases, nothing posts") — and it is an *architectural* fault, not a UI bug: two systems (outbox status vs. posting_status/apply_log) are both claiming to be the truth about the same business fact.

### 1.5 Root cause of the silent no-op (unconfirmed — first task of the fix)

`post_pos_statement_gl` (207 lines, `SECURITY DEFINER`) has only three success shapes: `already_posted`, `empty` (lines < 2, still writes apply_log + sets status=posted), and normal post (writes JE + apply_log + status=posted). Neither the apply_log write nor the status update happened, yet the dispatcher recorded success (no error, `last_error=NULL`). So one of the following must be true — this is the *first* thing the fix has to determine, not assume:

- The handler's RPC call is a silent no-op at the PostgREST layer (schema-cache stale, wrong overload, argument-name mismatch we haven't yet reproduced).
- An outer `EXCEPTION WHEN OTHERS` in a helper (`post_journal_entry_atomic`, `resolve_pos_tender_gl_account`, `get_default_account_id`) is swallowing an error and returning NULL/void.
- The RPC transaction is being rolled back after control returns to the edge function (e.g. a deferred constraint).

Any of these is an architecture defect: an outbox worker must never be able to report "succeeded" for a business event whose business invariant did not hold. §4.1 addresses this at the *contract* level, not just the incident level.

## 2. Enterprise principles I'll apply (SAP, Oracle Financials, D365 F&O, NetSuite, Workday, Odoo)

Recurring shape across mature ERPs:

1. **One Accounting Posting Engine, many producers.** POS, Sales, Purchases, Inventory, Payroll, Manufacturing, Fixed Assets, Bank all emit *sub-ledger accounting documents* into a single, generic posting pipeline. There is no POS-specific accounting infrastructure.
2. **Sub-ledger vs. general ledger separation.** Producers persist a sub-ledger fact (a "shift close", "invoice", "receipt"). A `SubledgerJournalEntry` (SAP: ACDOCA staging; Oracle: XLA events; D365: Sub-ledger journal) is derived from it. Only after that is a GL Journal Entry posted.
3. **Explicit accounting-event lifecycle**, not queue-row lifecycle:
   `Draft → Ready → Validated → Transferred → Posted → (Reversed | Cancelled | Superseded)`, with `Failed` and `NeedsMapping` as *distinct* diagnostic states, not a single "Waiting".
4. **Idempotency at the accounting-event level**, not just at the queue row. Retries produce the same JE (or none), governed by a business idempotency key (`<producer>:<doc>:<version>`), never the queue id.
5. **Manual retry is a business action** ("Post now"), not a queue action. If a mapping is missing, the correct verb is *Resolve mapping*, not *Retry*.
6. **The queue is invisible to the accountant.** The operational surface is "Accounting Events awaiting posting" — a business list. Queue rows, worker ids, attempts and backoff are diagnostics available to admins in a *support* view.
7. **Read/write split.** Reports are read-only projections of committed accounting events. Operations act on the accounting event itself, never on the report and never on the queue row.

## 3. The canonical target lifecycle

```text
POS shift close
      │  writes pos_statement (sub-ledger fact) atomically
      ▼
Accounting Event created           state=draft
      │  producer-agnostic row in accounting_events
      ▼
Validated                          state=ready
      │  mappings resolved, balanced, period open
      ▼  ── else ── state=needs_mapping | needs_period | invalid
Claimed by posting worker          state=posting
      │  single Posting Engine RPC
      ▼
Journal Entry posted               state=posted   (JE id recorded)
      │
      ▼
Reversed / Superseded / Cancelled  terminal states, audit-preserved
```

Queue infrastructure (`business_event_outbox`, workers, backoff, DLQ) is an *implementation detail underneath* the Accounting Event, not a peer of it.

## 4. What this plan will change

### 4.1 Contract: outbox success ⇔ business invariant

Introduce a single **`AccountingPostingResult`** contract returned by every posting RPC:

```
{ event_id, outcome: 'posted'|'noop'|'needs_mapping'|'invalid'|'deferred',
  journal_entry_id?, unresolved?: [...], diagnostics?: {...} }
```

The dispatcher marks the outbox `succeeded` *only* when `outcome='posted'` **or** `outcome='noop'` (with an apply-log row proving the no-op). `needs_mapping` / `invalid` mark the event `blocked` (not "failed"), do **not** consume retry budget, and are surfaced as configuration problems, not transient errors. Every other path — including an exception — is `failed`. This makes the incident in §1.5 structurally impossible.

### 4.2 New domain: `accounting_events` (producer-agnostic sub-ledger)

- Schema: `id, org_id, business_id, branch_id, producer ('pos'|'sales'|'purchase'|...), producer_doc_type, producer_doc_id, event_kind ('shift_close'|'invoice'|...), state, business_idempotency_key UNIQUE, requested_at, validated_at, posted_at, journal_entry_id, last_diagnostic jsonb, version int`.
- RLS: org-scoped read for accountants/admins/owners; writes only via SECURITY DEFINER RPCs.
- Producer trigger for POS: on `pos_statements` close, INSERT one `accounting_events` row (replaces the current outbox-only enqueue). The outbox continues to exist but only as *transport* — its payload is `{ accounting_event_id }`.
- The three current sources of truth (outbox status, `pos_statement_gl_apply_log`, `pos_statements.posting_status`) are collapsed: `accounting_events.state` is authoritative; `posting_status` and `apply_log` become derived/audit rows.

### 4.3 A single Posting Engine RPC

`accounting_post_event(p_event_id, p_idempotency_key)` — one function, dispatched by `producer` + `event_kind` to producer-specific *builders* (`build_pos_shift_close_lines`, `build_sales_invoice_lines`, …). Builders are pure: (event) → (lines, unresolved). The engine handles validation, balancing, period check, `post_journal_entry_atomic`, apply-log, state transition, and diagnostics — one place, once. `post_pos_statement_gl` becomes a thin builder + retained shim for back-compat, then is deleted.

### 4.4 Retry & failure policy (real, not decorative)

- `Retry` (transient error): consumes retry budget, exponential backoff, ≤ max_attempts → DLQ.
- `Blocked/NeedsMapping`: retry disabled; only "Resolve mapping" clears it (which re-validates and, if ready, transitions to `ready`).
- `Superseded`: reversal of a posted event creates a new event; the previous stays posted, JE reversed via reversal JE.
- Manual "Post now" is only offered when `state in ('ready','blocked','failed')`; it re-runs validation + posting, never re-enqueues a duplicate outbox row.

### 4.5 Operational workspace (replaces "POS Posting Queue")

Route: **Finance → Operations → Accounting Events** (`/finance/operations/accounting-events`). Not a report.

Columns are business, not implementation: Event, Producer, Business Date, Amount, State, Diagnostic, Age, Action. State badges: `Ready`, `Blocked — needs mapping`, `Blocked — period closed`, `Posting…`, `Posted`, `Failed`, `Superseded`. Action verbs: **Review**, **Resolve mapping**, **Post now**, **Reverse**, **Cancel** — never "Queue Retry". No cross-references to other pages in the description; the page owns the workflow.

A collapsible "Delivery diagnostics" panel (admin-only) shows the underlying outbox row, worker id, attempts, last_error — for support, not for the accountant.

### 4.6 Report/operations separation preserved

The **POS Shift GL Integrity** report stays read-only and stops referencing the queue page. Both surfaces read from `accounting_events` (single source of truth), so they can't disagree by construction.

### 4.7 Navigation

- Remove "POS Posting Queue" from the current location.
- Add "Accounting Events" under **Finance → Operations**.
- Reports stay under **Finance → Reports** (POS Shift GL Integrity, Trial Balance, …), all read-only.

## 5. Delivery batches (each independently shippable; no big-bang)

- **B0 — Diagnose the current silent no-op.** Instrument `post_pos_statement_gl` (RAISE NOTICE at each early-return), replay the four succeeded outbox rows, capture the actual return shape, and record it in `docs/audit/pos-posting-silent-noop.md`. No behaviour change. This is the only "fix current bug" step; everything after replaces the surface it lived on.
- **B1 — Contract enforcement.** Change the dispatcher so `handlePosStatementPostingRequested` requires `AccountingPostingResult` with `outcome='posted' | 'noop'(+apply-log proof)`. Any other shape → outbox `failed` with structured diagnostic. Add architecture test.
- **B2 — `accounting_events` domain.** Schema, RLS, GRANTs, indices, producer trigger for POS. Backfill from existing `pos_statements` closed since epoch. Dual-write for one release.
- **B3 — Posting Engine RPC + POS builder.** `accounting_post_event` + `build_pos_shift_close_lines`. Route the outbox handler through the engine using `accounting_event_id`; keep `pos_statement_gl_apply_log` as an audit projection.
- **B4 — Operational workspace.** New `/finance/operations/accounting-events` page (business language, verbs from §4.5), admin-only diagnostics panel. Old "POS Posting Queue" route becomes a 301 to the new page for one release, then removed.
- **B5 — Report cleanup.** POS Shift GL Integrity re-sourced from `accounting_events`; cross-reference in description removed.
- **B6 — Delete POS-specific posting infrastructure.** Remove `retry_pos_statement_posting` (superseded by `accounting_events_post_now`), inline `post_pos_statement_gl` as the POS builder, drop dual-write. Architecture tests forbid new producer-specific posting RPCs.

## 6. Engineering standards checkpoints (enforced by architecture tests)

- No new `*_posting_queue`, `retry_*_posting`, or `post_*_gl` public RPC per producer — must go through `accounting_post_event`.
- Outbox handlers may only mark `succeeded` on a typed `AccountingPostingResult`.
- UI must not read `business_event_outbox` on non-admin surfaces; the accountant list is derived from `accounting_events`.
- Every accounting producer (POS, Sales, Purchases, Payroll, …) added later plugs in as a *builder*, not as a new pipeline.

## 7. Out of scope for this plan (call out explicitly)

- Multi-currency revaluation and inter-company elimination — orthogonal, addressed in a later plan on top of this canonical pipeline.
- Real-time streaming replacement of `pg_cron`+outbox — the transport is fine; the audit is about the domain model on top.

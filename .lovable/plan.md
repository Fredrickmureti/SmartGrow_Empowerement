# Finance Wave 2 — Bank Feeds & Matching Reconstruction

Wave 1 (bank account lifecycle, single ingestion engine, session lifecycle,
currency integrity, derived cash position) is verified complete: the five
`bank_account_*` seams, `bank_statement_import_batch`, the six
`bank_reconciliation_session_*`/`item_set` seams, `bank_account_positions`
(ADR-0141) and the SQL invariant suites (`bank_account_lifecycle_invariants`,
`bank_statement_ingestion_invariants`, `bank_reconciliation_lifecycle_invariants`,
`banking_privilege_ratchet`, `bank_ownership_invariants`) all exist.

This wave closes the two halves Wave 1 did not touch: **how external bank
activity arrives** (feeds) and **how a bank line is matched to ERP reality**
(matching/settlement).

```text
provider / CSV / upload → feed connection → sync run → import batch (done)
bank line → match proposal (n:m, partial, fee) → canonical AR/AP/GL engine → session
```

## Verified defects (evidence gathered this turn)

**D-9 — matching is one-line→one-document, full amount only.**
`reconcile_bank_transaction_atomic` settles `abs(txn.amount)` against a single
invoice or bill, and refuses any document already touched by another bank line.
So partial payment, one line → many documents, many lines → one document, and
"customer sent 50,000, bank credited 49,500 with a 500 fee" are all
unrepresentable — despite `record_multi_invoice_payment` /
`record_multi_bill_payment` already accepting allocation arrays.

**D-10 — hardcoded accounting resolution inside the matching RPC.**
It picks the bank GL account by `detail_type='checking' ... LIMIT 1` when the
account has no mapping, and AR/AP by `detail_type=... LIMIT 1`, bypassing the
default-account role resolution used everywhere else. It also passes
`_exchange_rate := 1` unconditionally, which misstates every foreign-currency
bank settlement and contradicts ADR-0136 (no silent parity).

**D-11 — suggestion engine is organization-scoped and evidence-poor.**
`get_reconciliation_match_suggestions` filters journal lines by
`organization_id` only, with no `business_id` — one company's bank line can be
proposed against another company's journal inside the same organization. It
also only looks at already-posted journal lines on the control account, so open
invoices/bills, counterparty and document number are never used as evidence,
and its 1% tolerance / 30-day window / score thresholds are hardcoded in the
function body.

**D-12 — a second rule engine writes match rows directly.**
`apply_reconciliation_rules` inserts into `bank_reconciliation_matches` and
stamps `bank_transactions.match_source`, `match_confidence` and
`reconciled_type = 'to_check'` — a hidden lifecycle state carried in the
"what was this reconciled to" column, parallel to the server-owned session
lifecycle and to `bank_transaction_apply_rules` (the ingestion-side rule
engine).

**D-13 — bank feeds have no connection or run entity.**
Feed state is denormalized onto `bank_accounts` (`provider_id`,
`access_token_encrypted`, `refresh_token_encrypted`, `token_expires_at`,
`sync_status`, `sync_error`, `auto_sync_enabled`, `sync_frequency`,
`last_sync_at`, `last_auto_sync_at`). There is no sync-run/attempt table, so a
failed, partial, throttled or duplicate sync leaves only a text field —
unobservable, unbounded, unauditable. Credentials also live on a business table
rather than in the secret store.

**D-14 — the only feed transport is provider-specific and country-specific.**
`supabase/functions/sync-bank-transactions/index.ts` (796 lines) hardcodes
Jenga/Equity signing, endpoints and payload shapes, mixing transport,
normalization and orchestration in one Deno function inside core Finance.

**D-15 — two orphans.** `reconciliation_sessions` (0 rows, superseded by
`bank_reconciliation_sessions`, no application reference) and
`bank_transaction_splits` (0 rows, no reader, no writer).

## Phases

**Phase 10 — matching model.** Introduce a proposal→confirmation seam over
`bank_reconciliation_matches` supporting n:m allocation and a fee/residual leg:
`bank_match_propose`, `bank_match_confirm`, `bank_match_reject`,
`bank_match_reverse`. Confirmation delegates settlement to
`record_multi_invoice_payment` / `record_multi_bill_payment` with the real
allocation array and the residual posted as a bank-charge line through
`post_journal_entry_atomic`. Sum of allocations + residual must equal the bank
line; a document may be settled by several lines up to its open amount.
Replace `reconcile_bank_transaction_atomic` with a thin shim over the new seam,
then delete it and migrate `useBankTransactions`.

**Phase 11 — resolution + FX correctness.** Bank GL, AR and AP accounts resolve
through the existing default-account role authority; no `LIMIT 1` guessing, no
`detail_type` literals. Exchange rate comes from `require_exchange_rate` on the
transaction date; a missing rate is a refusal, never 1.

**Phase 12 — evidence-based suggestions.** Rebuild suggestions as a
business-scoped projection over open AR/AP documents plus unmatched control-
account journal lines, scoring amount, date proximity, reference/document
number, counterparty and payment history, with tolerances read from
configuration rather than baked into the body. Business scope is a hard filter.

**Phase 13 — one rule engine.** Fold `apply_reconciliation_rules` into the
proposal seam: rules produce proposals, never match rows or
`reconciled_type` writes. Remove `match_source`/`match_confidence` overloading
in favour of the proposal record; drop `apply_reconciliation_rules`.

**Phase 14 — feed connections and runs.** Model `bank_feed_connections`
(account, provider, status: connected / expired / revoked / suspended,
consent + credential reference, cursor, last success) and `bank_feed_sync_runs`
(attempt, window, counters, outcome, error class, rows accepted/rejected/
duplicate). Every sync is a run row; retries are bounded and idempotent by
`(connection, window)`; credentials move to the secret store keyed by
connection, never on `bank_accounts`. Drop the denormalized feed columns and
their reads.

**Phase 15 — transport adapters.** Reduce the feed to `fetch window → raw rows`
adapters (provider API, CSV, upload, manual) behind one orchestrator that hands
every source to `bank_statement_import_batch`. Jenga-specific signing becomes
one adapter/localization concern; core Finance holds no bank-specific code.
Retire `sync-bank-transactions` as an accounting path.

**Phase 16 — bank-vs-GL integrity.** Verify `bank_account_positions` +
`get_control_account_reconciliation` distinguish *unreconciled* from
*accounting discrepancy*, and surface the difference with its explanation
(in-transit, outstanding, fees, duplicates, missing postings) on the banking
surface.

**Phase 17 — destructive cleanup + ratchets.** Drop
`reconciliation_sessions` and `bank_transaction_splits`; extend the SQL suites
(match allocation invariants, FX refusal, feed run idempotency, business-scope
leak test) and add architecture ratchets forbidding the retired RPCs, the
denormalized feed columns and bank-specific code in core Finance. ADR for the
matching seam + feed connection model; update `mem/features/banking-domain.md`.

## Out of scope

AR/AP internals, budgets, assets, reporting redesign, POS settlement. Their
engines are consumed, never duplicated.

# Invoice → Accounts Receivable: one accounting engine

## What I verified in your data (not assumed)

Your organisation has exactly one invoice, INV-00001 (Joshua Holdings, HQ branch).

| Layer | State |
|---|---|
| `invoices` row | created 01:11 UTC, edited 10:36, confirmed 10:37, now `sent`, total 9,000 |
| Journal entry JE-00004 | created **10:37 UTC** — Dr 1100 Accounts Receivable 9,000 / Cr 4010 Sales Revenue 9,000, contact stamped, posted |
| `finance_ar_open_items` | 1 row, residual 9,000 |
| `customer_ledger_entries` | 1 row, debit 9,000 |
| Aging RPC inputs (org/business/branch/date/residual) | all match — the row is returnable |

So the GL-anchored side is *correct today*, and it became correct only at 10:37 — three minutes after you reported the discrepancy. Before that moment the invoice existed as an operational sales document with **no journal entry at all**. That is the real defect, and it is structural, not a display bug.

## Root cause

There are two competing definitions of "outstanding invoice":

1. **Operational (Sales) definition** — count/sum rows in the `invoices` table whose `status` is in `sent, viewed, partial, overdue, confirmed`. Used by the Finance dashboard (`FinanceDashboard.tsx` via `get_invoice_status_counts`), `useDashboardStats`, `useDashboardAnalytics`, `useExecutiveStats`, `ExecutiveReceivables`, and the salesperson dashboard. No journal entry is required for a row to count.
2. **Accounting (GL) definition** — `finance_ar_open_items` → `get_ar_ap_aging_from_ledger`, which per ADR-0033 only admits documents that have a **posted journal entry on the AR control account**. Used by Accounts Receivable, Aging, Customer Ledger/Statements, Collections, Control Account Reconciliation.

These agree only when *every* non-draft invoice has a posted AR journal. Nothing in the system enforces that. Confirmed holes found in code:

- `usePOSInvoiceRequest.ts` inserts invoices with `status: "confirmed"` directly — **no AR/revenue journal is ever created**. Revenue is never recognised; the invoice is permanently a dashboard-only phantom.
- `useRecurringInvoices.ts` inserts with `status: ri.auto_send ? "sent" : "draft"` — an auto-sent recurring invoice is posted-looking with no journal.
- `useInvoicesPaginated.confirmInvoice` posts the JE and then, in a **separate non-transactional statement**, writes `status = 'sent'`. A failure between them leaves a posted JE with a draft invoice (the inverse phantom).
- Two parallel invoice hooks (`useInvoices`, `useInvoicesPaginated`) implement confirmation with different post-confirm statuses (`confirmed` vs `sent`), so status vocabulary itself is not canonical.
- No database invariant forbids an invoice leaving `draft` without `journal_entry_id`.

Verdict: **Accounts Receivable was right; the Finance dashboard was wrong.** Sales document status is an operational fact, not an accounting fact, and must never be the source of a receivable figure.

## Target architecture

Single canonical projection, one query shape, GL-anchored, used by every finance surface:

```text
invoice (operational doc)
   └─ confirm  ──► confirm_invoice_atomic  ──► journal_entry (posted)
                                                 └─ journal_entry_lines (AR control, contact stamped)
                                                        └─ finance_ar_open_items   ← the ONLY AR truth
                                                              ├─ aging / AR workspace
                                                              ├─ customer ledger + statements
                                                              ├─ collections
                                                              ├─ finance dashboard KPIs
                                                              └─ executive / salesperson KPIs
```

Sales surfaces may still count invoice documents by status — but they must be labelled as *document pipeline*, never as receivables or expected cash.

## Work

### 1. Canonical AR summary (server side)
New `SECURITY DEFINER` SQL function `get_ar_summary(_org, _business, _branch, _as_of)` returning one row: `open_document_count, total_residual, not_due, current, days30, days60, days90, overdue_count, unposted_document_count, unposted_amount`. It aggregates `finance_ar_open_items` (single scan, indexed on org/business/branch — no N+1, constant round-trips at any invoice volume) and separately counts *unposted* non-draft invoices so the gap is reported instead of hidden. Mirror `get_ap_summary` for symmetry. Grant EXECUTE to `authenticated`.

### 2. Rewire every finance reader onto it
- `FinanceDashboard.tsx` — "Customer Invoices" card shows AR from `get_ar_summary`; the status-count RPC is demoted to the draft/overdue *document* badges only.
- `useDashboardStats`, `useDashboardAnalytics` (receivables + aging buckets + top debtors), `useExecutiveStats`, `ExecutiveReceivables`, `ReceivablesWidget`, salesperson dashboard — all drop their `invoices`-table arithmetic and read the summary/aging projection.
- Payables get the same treatment against `finance_ap_open_items` so AP cannot drift the same way.

### 3. Close the posting holes (the actual bug)
- `usePOSInvoiceRequest` and `useRecurringInvoices` create invoices as `draft` and then go through `confirmInvoiceAndPostGL`, exactly like the sales path.
- Fold the post-confirm `status = 'sent'` write into `confirm_invoice_atomic` so status flip and JE post are one transaction; delete the follow-up update.
- Collapse `useInvoices`/`useInvoicesPaginated` confirmation onto the one shared `confirmInvoiceGL` contract with a single post-confirm status (`sent`).

### 4. Database invariant
Trigger on `invoices`: reject any transition out of `draft` (and any insert with a non-draft status) unless a posted journal entry exists for that invoice, except for explicitly flagged migration/opening-balance loads. This makes the phantom state unrepresentable rather than merely unlikely.

### 5. Visible integrity, not silent divergence
- Backfill/repair RPC `post_missing_invoice_journals` (bounded, paginated, audit-logged) plus a "Documents without journals" section in the existing Accounting Integrity panel, driven by `unposted_document_count` from step 1.
- Keeps the historical POS/recurring phantoms fixable instead of stranded.

### 6. Guards
- Architecture test forbidding new reads of `invoices.status` for anything named receivable/outstanding/aging/expected-cash outside the sales document surfaces.
- pgTAP: posted invoice appears in `get_ar_summary`; draft does not; unposted non-draft is rejected by the trigger; summary total equals the AR control account balance in trial balance.
- ADR documenting `finance_ar_open_items` as the sole AR authority and Sales invoice status as operational-only.

## Technical notes

- Overloaded `get_control_account_reconciliation` currently exists in both 3-arg and 4-arg forms, which is a latent PostgREST ambiguity error; the 3-arg legacy overload gets dropped in the same migration.
- All new aggregation happens in SQL over the existing GL-gated views; no per-invoice client loops are introduced, and the dashboard goes from N document rows to one aggregate row.
- No change to how journals are built or which accounts are chosen — account resolution stays exactly as it is today.

## Definition of done

After posting an invoice, the Finance dashboard, AR workspace, aging, customer ledger, customer statement, collections, executive KPIs, and trial balance all report the same receivable, because all of them read the same GL-gated projection. An invoice that has not been posted appears nowhere as a receivable — it appears as an integrity exception.

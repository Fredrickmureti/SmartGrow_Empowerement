---
name: Collections & open-items invariants
description: AR/AP open-items projections are currency-aware; sum base_residual_amount, age as of an explicit date, one statement per period, one email/activity ledger
type: feature
---

## Currency
`finance_ar_open_items` / `finance_ap_open_items` expose `currency`,
`exchange_rate` and `base_residual_amount`. `residual_amount` is a
DOCUMENT-currency amount — never sum it across rows. Every aggregate (aging,
exposure ranking, tie-out) uses `base_residual_amount`.
`finance_open_items_tieout` compares base residual against the GL; drift must
stay `0.00`.

## As-of aging
`fetchContactOpenItemAging(side, { ..., asOf })` ages against `asOf`
(YYYY-MM-DD) and filters `document_date <= asOf`. Customer and vendor
statements pass `period_end`, so reprinting a closed period reproduces its
original buckets. Never rely on the browser clock for a dated document.

## Statements
One statement per `(business, branch, contact, period_start, period_end)`,
enforced by the unique index `customer_statements_one_per_period`.
`upsert_customer_statement_atomic(_payload jsonb)` is the only writer — no
client-side insert into `customer_statements`.

## Communications
`document_emails` + `audit_logs` are the single email/activity trail, written
on both the success and failure paths of `send-document-email`. The legacy
`invoice_reminders` / `invoice_emails` / `invoice_activities` tables were
dropped — do not reintroduce a per-document-type activity table.

## Guards
`src/test/architecture/aging-single-source.test.ts`

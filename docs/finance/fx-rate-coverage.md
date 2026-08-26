# FX rate coverage, publishing and history

Phase 4 of the currency architecture remediation. Companion to
`docs/audits/currency-architecture-audit.md` (finding D8).

Governing rule: **a rate is evidence, never a guess.** Nothing in this system invents,
interpolates or extrapolates a rate. When no rate is on file for a document's date, the
document is refused and a finance manager must record a dated override with a reason.

## Where rates come from

```text
provider API  ──provider-run (edge fn)──▶  platform_exchange_rates   (USD-based snapshot)
                                                     │
                                    publish_platform_rates()  (cron: 5,35 * * * *)
                                                     ▼
                                         exchange_rates            (per org/business, dated)
                                                     │
                            _pick_exchange_rate_row → resolve_exchange_rate
                                       → require_exchange_rate → fx_stamp_document
                                                     ▼
                                         stamped document rate (immutable once posted)
```

- `platform_exchange_rates` holds one **current** USD-based row per currency. It is a snapshot,
  not a history, and is refreshed by the `provider-run` edge function using the configured
  provider (exchangerate.host, openexchangerates.org or fixer.io).
- `publish_platform_rates()` triangulates `code -> base` as `(USD -> base) / (USD -> code)` and
  writes one dated `provider` row per business per currency per day. It is idempotent — the
  unique index `exchange_rates_scope_unique` absorbs repeats and the function returns the number
  of rows actually recorded.
- Overrides are recorded through `set_exchange_rate_override(...)`, which requires a finance role
  and a mandatory reason, and are audited in `exchange_rate_audit` and `audit_logs`.

## Retention and publishing schedule

| Concern | Policy |
| --- | --- |
| Provider snapshot refresh | `provider-run`, on demand today; must be scheduled once provider credentials are configured |
| Rate publishing to `exchange_rates` | cron `publish-fx-rates`, every 30 minutes (`5,35 * * * *`) |
| Rate retention | **indefinite.** `exchange_rates` rows are immutable and are never deleted or purged — they are the evidence behind every stamped document |
| Corrections | never an edit; a new dated row (`source = 'override'`) supersedes, with a reason |
| Audit retention | `exchange_rate_audit` retained indefinitely, readable by finance managers only |

Rate coverage therefore begins on the day a business first published or recorded a rate. It is
**not** back-dated, because the provider exposes only a current snapshot: back-filling earlier
dates from today's snapshot would fabricate history.

## Coverage reporting

Two read-only functions, `authenticated`-execute, each enforcing company access internally:

- `fx_rate_coverage(business_id)` — one row per foreign currency actually used by the company
  across invoices, bills, vendor payments, bank transactions, estimates, sales orders, purchase
  orders, credit notes, customer refunds and expenses:

  | Column | Meaning |
  | --- | --- |
  | `first_used_on`, `last_used_on`, `document_count` | real usage of that currency |
  | `coverage_start`, `latest_rate_date`, `rate_dates` | extent of the rate book for that pair |
  | `latest_rate`, `latest_source` | the currently effective rate and its provenance |
  | `uncovered_documents` | documents dated before `coverage_start` |
  | `status` | `none` (no rate ever), `partial` (usage predates coverage), `stale` (latest rate older than 7 days), `covered` |

- `fx_rate_coverage_summary(business_id)` — the same data plus `provider_snapshot_as_of`,
  `provider_snapshot_age_days`, `last_published_at` and the counts the Currency Settings coverage
  indicator renders (Phase 8 consumes this; there is no UI yet).

## Policy for dates before coverage

1. The document is refused with `23514 — No exchange rate on file for X -> Y on <date>`.
   No 1:1 fallback exists on any path.
2. A finance manager records a dated override for that date through Currency Settings
   (`set_exchange_rate_override`), stating the source of the rate in the mandatory reason.
3. The document is saved and stamped from that override. The override remains visible as
   evidence, with actor, reason and prior value in `exchange_rate_audit`.

## Operational watch-outs

- `provider_snapshot_age_days` is the health signal for the pipeline: if it grows, `provider-run`
  is not being invoked and `publish_platform_rates` is re-publishing an ageing snapshot as
  today's rate. Configure provider credentials and schedule `provider-run` to close this.
- `fx_stamped_rate_review(business_id)` (Phase 3) lists documents whose stamped rate disagrees
  with the rate book. It reports; it never rewrites.

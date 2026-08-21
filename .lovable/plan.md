# Currency & FX — Phase 9 (reversal symmetry) execution status

Authority: ADR 0135 / 0136 / 0138. Predecessor:
`.lovable/plan/currency-fx-handover-verification-2026-08-22-and-phase-9-rew-2026-08-21.md`.

## Phase 9.0 — Re-prove the suites — DONE
- `bunx vitest run src/test/architecture/fx-single-engine.test.ts` → **31 passed**.
- Rate-book sweep re-run live: only `_pick_exchange_rate_row` reads
  `public.exchange_rates`; only `publish_platform_rates` and
  `set_exchange_rate_override` write it.
- `to_base_amount`, `record_multi_invoice_payment`, `record_multi_bill_payment`
  carry no `COALESCE(rate, 1)`.
- The `.sql` suites cannot be executed from this environment (no direct psql;
  the query tool is SELECT-only). Their catalogue assertions were re-run as
  read-only SELECTs instead and hold. UNVERIFIED: the DML fixtures inside those
  suites.

## Phase 9.1 — Reversal source of truth — DONE (answered)
VERIFIED FACT: `journal_entry_lines` carries `original_currency`,
`exchange_rate`, `original_debit`, `original_credit`; `journal_entries` carries
`currency`, `exchange_rate`. `post_journal_entry_atomic` stamps the line columns
whenever a line is submitted with its own currency; settlement paths submit
base-denominated lines with the denomination on the header.
DECISION: reverse-from-journal. No currency column is added to `payments`.

VERIFIED FACT (corrects the wave's F1): `void_payment_atomic`,
`void_bill_payment_atomic` and `unapply_vendor_credit_from_bill_atomic` already
reverse through `void_journal_entry_atomic`, which mirrors every line —
including the realised-FX line. They were **not** defective. The genuine defects
were narrower:
1. `void_journal_entry_atomic` dropped line-level FX metadata (and header
   currency/rate) from the reversal.
2. `unapply_payment_atomic` hand-built a two-line entry at the payment's face
   `applied_amount` with no rate and no FX back-out.

## Phase 9.2 — AR reversal symmetry — DONE
- Migration 1: `void_journal_entry_atomic` now copies `original_currency` and
  `exchange_rate` onto reversal lines, mirrors `original_debit`/`original_credit`
  to the opposite side, carries `analytic_account_id`/`project_id`, and the
  reversal header inherits the original `currency` + `exchange_rate`.
- Migration 2: `unapply_payment_atomic` now mirrors the original settlement
  journal line-for-line, excluding the cash leg (the money stays in the bank and
  is reclassified), and plugs the balance to customer deposits. The receivable is
  restored at the base amount it was relieved at and any realised gain/loss is
  backed out. No rate is resolved. Legacy payments with no posted settlement
  journal keep the face-value behaviour.

## Phase 9.3 — AP reversal symmetry — DONE (no change required)
Verified: the AP reversal paths already delegate to `void_journal_entry_atomic`
and therefore inherit Migration 1's fix. No duplicate reversal engine exists.

## Phase 9.4 — Tests — DONE
New `supabase/tests/fx_reversal_symmetry_test.sql` (read-only, DML-free):
reversal lines must preserve and mirror FX metadata; no reversal path may call
`resolve_exchange_rate`/`require_exchange_rate` or carry a parity fallback;
`unapply_payment_atomic` must derive from the settlement journal. Every
assertion re-checked live and holds.

## Phase 10 — Tenant-facing absence states — PENDING (NEXT)
Surfaces receiving NULL (vendor/customer credit totals, counterparty nets,
dispute and promise forms) must render an explicit "no rate on file" state
linking to the rate book, per ADR 0136.

## Phase 11 — Isolation ratchet — PENDING
Business-scoping assertions on `fx_exposure_by_currency`,
`fx_exposure_open_items`, `fx_revaluation_readiness`, `describe_exchange_rate`.

## Notes
- Linter baseline unchanged at 3599 across both migrations.
- Live `exchange_rates` still holds base-currency rows only; foreign paths remain
  correct by construction and by catalogue tests, not by exercised tenant data.
- Supabase binding is `jkszmrroyjfdwokbkzis`; attaching `AccrualFlowCorporation`
  would be a destructive re-bind and remains out of scope.

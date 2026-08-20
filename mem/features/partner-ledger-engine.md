---
name: Partner ledger engine (AR/AP)
description: Partner Ledger balances are SQL-owned via finance_partner_ledger; strict branch scoping, base-currency ledger columns, GL tie-out required
type: feature
---

The Partner Ledger is a projection of the AR/AP sub-ledger. Opening, running and
closing balances are accounting output and are computed in SQL.

- **Engine**: `finance_partner_ledger(_org_id, _business_id, _branch_id, _side,
  _from, _to, _contact_id, _search, _limit, _offset)` over
  `customer_ledger_entries` / `vendor_ledger_entries`. Org-gated by
  `finance_can_read_org`; `anon` EXECUTE revoked.
- **Client seam**: `src/services/finance/partnerLedger.ts` is the only caller;
  `src/hooks/usePartnerLedger.ts` is the only hook. Never page ledger views into
  the browser and never accumulate balances in JS.
- **Branch scoping is strict**: `_branch_id IS NULL OR branch_id = _branch_id`.
  Never `branch_id = X OR branch_id IS NULL` — that absorbs unbranched entries
  into a branch-scoped report.
- **Currency**: `journal_entry_lines.debit/credit` (and therefore the ledger
  views) are BASE currency; document currency lives in
  `original_debit/original_credit`. Do NOT add FX conversion to ledger balances.
- **Tie-out**: `finance_partner_ledger_reconciliation` compares the closing
  position to the AR/AP control account. Non-zero variance is a bookkeeping
  finding and must be surfaced, not hidden.

Guards: `supabase/tests/partner_ledger_engine_test.sql`,
`src/test/architecture/partner-ledger-server-owned.test.ts`.

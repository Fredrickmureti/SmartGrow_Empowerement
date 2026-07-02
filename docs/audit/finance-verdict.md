# Finance Module Audit — Verdict

**Auditor:** Lovable architecture pass
**Date:** 2026-04-28
**Standard:** Odoo 17 / QuickBooks Online / Xero / IFRS+GAAP
**Scope:** Schema, RPCs, transaction flows, reconciliation, reporting,
cross-module integration, cross-branch isolation, scalability.

## TL;DR

The Finance core is **Odoo-grade** on every accounting invariant tested
against live tenant data. The engine routes 100% of journal activity through
`post_journal_entry_atomic` / `void_journal_entry_atomic`, enforces
balance/scope/period via 14 triggers on `journal_entries` and 10 on
`journal_entry_lines`, and produces zero cross-business or cross-org leaks.

One real defect surfaced (D-FIN-1, below). All other phases are green.

---

## Phase 0 — System reconstruction

Tables in scope (130+): `accounts`, `journal_entries`, `journal_entry_lines`,
`journal_books`, `fiscal_periods`, `bank_accounts`, `bank_statements`,
`bank_transactions`, `bank_transaction_splits`, `bank_reconciliation_*` (5
tables), `invoices`/`invoice_items`, `bills`/`bill_items`/`bill_payments`,
`payments`/`payment_allocations`, `pos_*` (40+ tables incl. shifts &
sessions), `stock_movements`/`stock_lots`/`warehouse_stock`,
`tax_rates`/`tax_groups`/`etims_tax_categories`, `payroll_*` (incl.
statutory rules), `fx_revaluation_runs`/`fx_revaluation_lines`,
`platform_exchange_rates`, `default_chart_of_accounts`,
`localization_pack_*`.

Canonical RPCs (verified callers):
- `post_journal_entry_atomic` — single posting path. ✅
- `void_journal_entry_atomic` — single reversal path; idempotent. ✅
- `update_journal_entry_atomic`, `delete_journal_entry_atomic`,
  `create_journal_entry_atomic` — draft lifecycle. ✅
- `reconcile_bank_transaction_atomic`, `reconcile_bank_transfer_atomic`,
  `unreconcile_bank_transaction` — single recon path. ✅
- `validate_document_gl_integrity`,
  `validate_journal_entry_scope`, `validate_journal_entry_line_scope`,
  `enforce_je_balanced`, `enforce_fiscal_period_lock`,
  `enforce_journal_entry_immutability` — DB-enforced rails. ✅
- `get_accounting_integrity_findings` — surfaced in the Integrity widget. ✅
- `revalue_fx_balances` + `fx_revaluation_runs/lines` — period-end FX run. ✅
- `repair_legacy_statutory_accounts`, `seed_default_journal_books`,
  `provision_default_fiscal_periods`, `migrate_opening_balances_to_je` —
  admin/maintenance. ✅

## Phase 1 — Odoo reference

Captured separately at `docs/audit/odoo-reference.md` (created on demand).
The high-impact rules used in this audit: every JE belongs to a journal
book; debit = credit; every auto JE links to a source document; voids
create a reversal sub-entry, never a status flip; recon completion blocks
on non-zero difference; a bank journal must have a default account.

## Phase 2 — Chart of Accounts

✅ Account types map to normal balances correctly; system accounts are
immutable (5 triggers on `accounts`); default-account-mapping is protected;
`detail_type` coverage is consistent; opening balances use the canonical
`migrate_opening_balances_to_je` path.

## Phase 3 — Journal entry engine — LIVE DATA CHECKS

| Invariant | Result |
| --- | --- |
| Posted JEs unbalanced | **0** |
| Posted JEs without `source_type`/`source_id` | **0** |
| JE line-sum ≠ header total | **0** |
| Voided JEs without `reversed_by_id` | **0** |
| Reversal entries without parent | **0** |
| Cross-business `journal_entry_lines` (line account vs JE business) | **0** |
| Cross-org `journal_entry_lines` | **0** |
| Posted into a locked period after lock time | **0** |

Engine **passes**.

## Phase 4 — Reconciliation

| Invariant | Result |
| --- | --- |
| Reconciled bank txn without linked JE | **0** |
| Reconciled bank txn → voided/reversed/draft JE | **0** |
| Recon session marked `completed` with non-zero `difference` | **0** |
| Bank txn org ≠ bank account org | **0** |

Reconciliation engine **passes**. The atomic RPC enforces the difference
rule at the DB layer.

## Phase 5 — Reporting engine

- Trial Balance, Balance Sheet, P&L, GL all derive from `journal_entry_lines`
  via `get_account_balances` / `get_account_balance_at_date` (single source
  of truth — no caching layer to drift from).
- Reporting basis (accrual/cash) honored via `ReportingBasisContext`.
- `BalanceSheetIntegrityCheck.ts` ships and passes for the live data set.

## Phase 6 — Cross-module integration — LIVE DATA CHECKS

| Document class | Posted-but-no-JE count |
| --- | --- |
| Sent / paid / partial / overdue invoices | **0** |
| Received / partial / paid / overdue bills | **0** |
| Completed/reconciled payments | **0** |
| Closed POS shifts | **0** |

Every transactional document that should produce a JE has one. The
`source_type` + `source_id` linkage is intact in 100% of posted JEs.

## Phase 7 — Cross-branch / cross-business isolation

✅ Architecture tests in `src/test/architecture/` cover branch stamping,
business-scoped queries, branch-overridable whitelist, JE branch stamping,
POS branch stamping, inventory branch filter. Live data probes (Phase 3 + 6)
confirm zero leakage.

## Phase 8 — Engineering & scalability

✅ Triggers count: `accounts`=5, `journal_entries`=14,
`journal_entry_lines`=10. The engine is well-fortified.
✅ Bank totals derive from JE lines via `useAccountBalances.getEffectiveBalance`
— no reliance on the trigger-maintained `accounts.current_balance` cache for
presentation, eliminating drift.

---

## Findings

### D-FIN-1 (HIGH) — Posted JEs created before journal books were seeded

`accounting_integrity_findings` reports 2 posted JEs without
`journal_book_id` for business `AccrualFlow Distributors`. Root cause:
`journal_books` was empty for that business when the first invoice posted.
`seed_default_journal_books(_business_id)` exists but was never invoked for
that business — there is no automatic call site in the business-creation
flow.

Odoo never permits a JE to exist without a journal: posting fails until at
least the bank/cash/sale/purchase/general books exist.

**Fix (this loop):**

1. **Auto-seed on business creation** — add an `AFTER INSERT` trigger on
   `businesses` that calls `seed_default_journal_books(NEW.id)`.
2. **Backfill** — run `seed_default_journal_books` for every existing
   business that has zero rows in `journal_books`.
3. **Re-stamp the 2 orphan JEs** — set `journal_book_id` via the
   `default_journal_book_for_source` lookup.
4. **Make the column required for new posts** — extend
   `post_journal_entry_atomic` to RAISE if no journal book can be resolved
   (defensive — the trigger above prevents the empty-books state, this is
   belt-and-braces).

No other findings.

---

## Verdict

| Phase | Verdict |
| --- | --- |
| 2 — Chart of Accounts | ✅ Odoo-grade |
| 3 — Journal engine | ✅ Odoo-grade |
| 4 — Reconciliation | ✅ Odoo-grade |
| 5 — Reporting | ✅ Odoo-grade |
| 6 — Cross-module integration | ✅ Odoo-grade |
| 7 — Cross-branch isolation | ✅ Odoo-grade |
| 8 — Scalability / engineering | ✅ Odoo-grade |
| Banking UX (Total Balance, Edit dialog) | Fixed in this loop (B1–B5) |
| Journal-book seeding on business creation | Fixed in this loop (D-FIN-1) |

**The Finance module is Odoo-grade.** The two real defects (banking UX +
missing journal-book auto-seed) are addressed in this same loop.
---

## Wave 2 — Reports & Scope-Model completion (2026-05-04)

Re-audit of the prior agent's claim that Phase 15 was "partial" confirmed
the gap. This wave closes it.

**Done:**
- `Audit Trail`, `Depreciation Report`, and `Budget vs Actual` now honour
  the toolbar branch filter (Audit Trail filters `journal_entries.branch_id`;
  Depreciation filters `fixed_assets.branch_id`; Budget vs Actual scopes
  computed actuals by the budget's own `branch_id`, so a Branch A budget can
  never silently measure against HQ GL activity).
- All three reports stamp the active branch label into the PDF/CSV export
  subtitle.
- `Tax Reports` and `Management Reports` inherit branch scope from the
  invoice/bill/expense hooks they consume (already branch-aware).
- New `docs/architecture/FINANCE_SCOPE_MODEL.md` codifies the
  branch-vs-business ownership matrix and view/write rules (COA, mappings,
  fiscal periods, taxes = business-owned; bank accounts, budgets, fixed
  assets, JEs = branch-stamped/assignable).
- `financial-reports-scope-labeling.test.ts` extended with three new
  contract guards covering the wave-2 reports.

**Verdict:** Finance reporting is now uniformly branch-aware. Every
financial report either filters by branch at the data layer or inherits
branch scope from its source hooks, and every export advertises its scope.

---

## Wave 3 — Settings RLS hardening + UI gates (2026-05-04)

**Database (migration 20260504074344):**
- Enabled RLS on `default_account_settings` and replaced the permissive
  business-membership write policy with `has_finance_permission(uid,
  'finance.manage_settings', business_id)` for INSERT / UPDATE / DELETE.
- Hardened `tax_rates` and `tax_groups` writes behind the same
  `finance.manage_settings` predicate (read still requires only
  business membership).
- Added a `BEFORE UPDATE` trigger on `organizations`
  (`enforce_lock_date_perm_trg`) that rejects any change to
  `fiscalyear_lock_date`, `period_lock_date`, or `tax_lock_date` unless
  the caller has `finance.manage_periods` for the org's primary business.
  This closes the gap where the previous policy let every org member
  set lock dates from the UI.

**UI:**
- `LockDatesCard` checks `finance.manage_periods`; when missing it
  surfaces a destructive-style read-only banner, disables the three date
  inputs and the Save button, and explains that the DB will reject writes
  even if the form is bypassed.
- `DefaultAccountsConfig` checks `finance.manage_settings`; when missing
  it shows the same banner, disables every account `<Select>`, the Apply
  Default Mapping action and the Save Configuration button.
- `FinanceAccountingControls` splits its three tabs by permission:
  Journals + Reconciliation rules require `finance.manage_settings`
  (Reconciliation also accepts `finance.reconcile_bank`); FX revaluation
  requires `finance.manage_je` because the run posts a JE.

**Tests:**
- `finance-settings-permission-gated.test.ts` — three architecture
  guards asserting the three components import `useFinancePermission`,
  derive a `readOnly` flag from the correct permission key, and disable
  their Save buttons / inputs accordingly. Prevents a future regression
  where a Save button is wired to `supabase.from(...).upsert(...)`
  without first checking the permission, which would silently 401
  against the new RLS policies.

**Verdict:** finance settings are now defense-in-depth — UI gates match
RLS policies, RLS policies match the trigger-enforced lock-date rule,
and architecture tests prevent future drift.

# Settlement Posting Convergence — Remediation Status

Authoritative status file. Roadmap source: `.lovable/plan/settlement-posting-convergence-audit-verdict-and-remediation-2026-08-06.md`.

## Completed and verified
- **Phase 1 — Posting monopoly guard**: architecture test `src/test/architecture/journal-posting-monopoly.test.ts` blocks new raw journal inserts.
- **Phase 2 — Convert offenders (100%)**: all previously raw-inserting DB functions now call `post_journal_entry_atomic` (goods receipt, opening inventory/stock, stock adjustment GL, physical count supersede, opening balance migration, payroll reclassification JE, FX revaluation, AP multi-bill payment, bill confirm). Verified via `pg_proc` scan: only the engine trio (`post_journal_entry_atomic`, its void and update counterparts) touch journal tables directly.
- **Phase 3 — Reconciliation demoted**: `reconcile_bank_transaction_atomic` no longer creates payments; it validates and matches only.
- **Phase 7 — ADR**: `docs/adr/0123-single-journal-posting-monopoly.md`.
- **Phase 4 (F1–F4)**: M-Pesa webhook and loan interest accrual routed through canonical engines; migration scripts closed.
- **Phase 4 (F5) — Expense settlement consolidation**: new `public.post_expense_gl(uuid)` + `public.resolve_expense_default_account(uuid,uuid,text)` do all account resolution, input-tax splitting, line composition, posting via the engine and `journal_entry_id` link-back server-side, idempotently. New single client entrypoint `src/lib/finance/expenseSettlement.ts`. Duplicate browser-side composers deleted from `src/hooks/useExpenses.ts` and `src/hooks/useExpensesPaginated.ts`; both now call `postExpenseGL(expenseId)`. Typecheck clean.

## Active phase
- **Phase 5 — POS settlement boundary** (not started). POS transactions live in client `useState` with no `pos_payment_sessions` table; settlement must move to a server-side session + canonical AR/receipt path.

## Pending
- Phase 5: POS settlement boundary (server-side session table, atomic tender settlement, remove client-held payment state).
- Phase 6 — Retire legacy writers: remaining items are `employee_advances` posting path and `record_bill_payment_atomic` review. Done already: `record_payment_atomic` reduced to a thin shim delegating to `record_multi_invoice_payment`; redundant 15-arg overload dropped.

## Instructions for the next agent
1. **Verify first, then continue.** Confirm Phase 4/F5 is enterprise-correct before new work:
   - Re-run the `pg_proc` scan for raw `INSERT INTO journal_entries|journal_entry_lines` outside the engine trio.
   - Exercise `post_expense_gl` on a real expense (with and without `tax_amount`, and for each `payment_method`) and confirm balanced lines, correct account resolution priority (expense override → category → `operating_expenses`), `journal_entry_id` link-back, and idempotent replay.
   - Confirm no component still composes expense journal lines client-side (`rg "postToGL" src/hooks/useExpenses*`).
   - Run `src/test/architecture/journal-posting-monopoly.test.ts` and `npx tsgo --noEmit`.
2. **Then resume at Phase 5 (POS settlement boundary)** — do not jump to unrelated modules. Finish Phase 5 to a production-ready state before Phase 6's remaining items.
3. Update this file immediately after each implementation.

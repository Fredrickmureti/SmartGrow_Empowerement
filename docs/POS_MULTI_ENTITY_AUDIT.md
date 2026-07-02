# POS Multi-Entity ERP Audit

## Verdict
POS now follows the target ERP boundary model: organization is the tenant, business is the accounting company, branch is the operational location, and POS register is the source of truth for POS branch context. The 10-step correction plan from the deep audit has been implemented.

## Odoo-aligned rules enforced
- Registers must belong to a company and branch.
- Terminal sessions derive business and branch from `pos_registers`, not cashier or UI state.
- POS shifts derive business and branch from the register.
- POS transactions, items, payments, and cashier-register links are NOT NULL `business_id` (Step 1).
- Cashier-register link rejects business mismatches via trigger (Step 2).
- Branch-level POS payment-method overrides are uniquely keyed by `(business_id, branch_id, method_key)` (Step 2).
- Shift close auto-posts to the GL (`trg_pos_shift_close_journal`) and rolls back the close on failure, recording into `pos_shift_close_errors` (Step 3).
- Shift close auto-refreshes the POS daily summary via DB trigger; client RPC removed (Step 4).
- Settings are resolved with deterministic precedence Register → Branch → Company via `resolve_pos_setting` (Step 5).
- POS readiness is checked before sale via `ensure_pos_ready_for_business`; UI surfaces a banner and blocks "Open Shift" when prerequisites are missing (Step 6).
- POS-credit invoice lineage points at `invoices.source_pos_transaction_id` (Step 7); legacy `source_recurring_id` remains as a deprecated fallback.
- `useTerminalSession` realtime channel is keyed by business and drops cross-company payloads (Step 8).
- New companies seed POS payment-method defaults via `seed_pos_defaults_for_business`, called from `BusinessContext.createBusiness` (Step 9).
- Compile-time guard test asserts every POS sub-table requires `business_id` on insert (Step 10).

## Database hardening applied
- `enforce_stock_movement_branch_scope()` validates stock movement organization, business, branch, and warehouse consistency.
- `process_pos_transaction()` writes stock movements with register-derived `branch_id` and rejects missing register branch context.
- Legacy non-branch-aware POS report RPC overloads were dropped.
- `enforce_cashier_register_business_match` trigger added (Step 2).
- `trg_pos_shift_close_journal` + `trg_pos_shift_refresh_daily_summary` triggers added on `pos_shifts` (Steps 3–4).
- `pos_shift_close_errors` audit table added with RLS scoped to `user_has_business_access`.
- `resolve_pos_setting`, `ensure_pos_ready_for_business`, `seed_pos_defaults_for_business` SECURITY DEFINER RPCs added.
- `invoices.source_pos_transaction_id` FK to `pos_transactions(id) ON DELETE RESTRICT` added with backfill.
- Updated `enforce_pos_credit_invoice_lineage` to prefer `source_pos_transaction_id`.

## Remaining security linter warnings
The post-migration linter reported pre-existing project-level warnings unrelated to this POS migration: extension in public, permissive RLS policy, public bucket listing policies, and leaked password protection disabled.

## Stage B — Branch operational isolation (2026-05-16)

Prior rounds enforced **Company** isolation (organization + business). Stage B
extends the boundary to **Branch** so a user operating inside Branch A can no
longer see, target, or accidentally mutate registers, sessions, shifts, or
realtime events that belong to HQ or to a sibling branch.

### Rules now enforced

- `usePOSRegisters` filters `pos_registers` by `branch_id = currentBranch.id`
  when a branch is active. HQ / no-branch context keeps company-wide
  visibility for overseers (read-only by convention).
- `useActivePOSRegister` and `useActiveOrDefaultRegister` resolve the
  hardware-routed till only within the active branch. They no longer bind a
  branch operator's printer/drawer to an HQ shift.
- `usePOSShifts` is branch-scoped: the dashboard "Current Shift" card,
  unsynced-shifts badge, and rescue alert reflect the active branch only.
- `usePOSCashiers` is branch-scoped: cashier pickers and assignment dialogs
  cannot surface a cashier pinned to another branch.
- New `useRegisterBranchGuard` + `<CrossBranchRedirect/>` block
  `/pos/terminal/:registerId` from mounting when the register's branch does
  not match the active branch. The wrapper guards before any inner hook
  runs (Rules-of-Hooks safe). HQ / no-branch is treated as wrong-branch for
  the terminal route specifically — operators must commit to a branch
  before opening a till.
- `useTerminalSession` realtime channel name and drop-filter now include
  `register.branch_id`. Cross-branch session payloads are discarded even if
  the server broadcasts them.
- `useWaitlist` realtime channel is keyed by org/business/branch and drops
  payloads whose `business_id` or `branch_id` do not match.
- Static guards (`posBranchIsolation.test.ts`) fail the build if any of
  these patterns regress.

### Visibility vs Mutation matrix

| Surface / Entity                | Branch user (in branch) | HQ overseer (no branch) | Other branch |
|---------------------------------|-------------------------|--------------------------|--------------|
| Registers list                  | own branch only         | all (read-only)          | none         |
| Open terminal / start shift     | own branch only         | blocked (switch prompt)  | blocked      |
| Force-end / unlock session      | own branch + permission | blocked                  | blocked      |
| Shifts dashboard / rescue       | own branch              | all (read-only)          | none         |
| Cashier picker                  | own branch              | all (read-only)          | none         |
| Payment-method overrides        | own branch (edit)       | read-only                | none         |
| Receipt branding / denom counts | own branch (edit)       | read-only                | none         |
| Chart of Accounts / GL defaults | read-only               | edit (company-level)     | read-only    |
| Tax mappings (company-wide)     | read-only               | edit                     | read-only    |
| POS reports                     | own branch              | branch picker + roll-up  | none         |

### Deferred to a follow-up round

- Server-side RPC guard `assert_pos_mutation_scope(register_id, branch_id)`
  called from `open_pos_shift`, `close_pos_shift`,
  `force_end_pos_session`, `process_pos_drawer_event`, and
  `process_pos_transaction`. Today the database trusts the application
  layer + `enforce_cashier_register_business_match` to keep branch
  consistency; the RPC guard is a defence-in-depth follow-up.
- BEFORE-INSERT/UPDATE trigger on `pos_sessions` and
  `pos_payment_method_overrides` to assert branch consistency at the
  storage layer.
- Splitting `POSSettings` into Company / Branch / Register accordions with
  per-scope edit gating (`who_can_edit` column on the resolver companion
  view).

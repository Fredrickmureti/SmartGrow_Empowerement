# Project Memory

## Core
Odoo-aligned: Workspace (organizations) → Company (businesses) → Branch (branches). User is always inside exactly one company + one branch — no "All" modes. Currency/COA/fiscal year live on Company only, never Workspace.
All user-composed document email goes through `SendDocumentDialog` (with `AIEmailAssistant`); never create per-document email dialogs.
Barcode Enrollment Workspace: persistence ONLY via `enroll_product_barcode` / `revoke_product_barcode` / `flag_product_for_review` RPCs; queue excludes products with `review_reason IS NOT NULL`; reducer must bump `seq` on every cursor-mutating action (stale-RPC contract); page owns scans via ONE top-priority `useScanTarget` — never import `scanBus` directly.
Opening stock requires `unit_cost > 0` on every line and posts Inventory ⇄ Opening Balance Equity via `approve_stock_adjustment_atomic` — never quantity-only, never zero-value. `product_categories` are deduped at source by unique index `(org, business, lower(name), parent_id) WHERE is_active`; never dedupe at render.
`products.base_uom_id` is immutable after any stock movement / cost layer / non-zero warehouse stock / transactional line (ADR 0035). Use `product_packaging` to transact in other units; sales/purchase UoM must share base category.
Attendance: portal/`/me/*` MUST use `useAttendanceActions` (RPC-only); admin uses `useAttendance`. Clock RPCs are forensic + policy-gated (geofence/selfie/device-trust/kiosk-PIN) and append every attempt — allow and deny — to `attendance_events` (append-only).
Enterprise UX: every create/edit for a business record is a `/new` or `/:id/edit` route on `RecordFormShell`; every substantial detail peek is a `?peek=<id>` `PeekScaffold` sheet — never a `Dialog`/`Drawer`. Scaffolds import from `@/design-system` only. Architecture guards: `sales-record-dialog-ban` (empty allowlist — frozen), `purchases-record-dialog-ban` (empty allowlist — frozen), `inventory-record-dialog-ban` (5 legacy drawers, shrink-only), `finance-record-dialog-ban` (14 legacy dialogs, shrink-only). Migration ledgers under `docs/design-system/audit/{sales,purchases,inventory,finance}.md` are the source of truth for progress.

## Memories
- [Unified email dialog](mem://constraints/unified-email.md) — SendDocumentDialog is the single user-composed email surface; send-receipt-email is deleted
- [Barcode enrollment invariants](mem://features/barcode-enrollment.md) — Scan ownership, enroll/revoke RPC contract, primary-promotion rule, and the reducer seq guard
- [Hardware platform — Post 9d](mem://features/hardware-platform.md) — device_assignments canonical; hardwareClient is the single chokepoint; main-process drivers authoritative; runtimeCapability() is the live probe; never reintroduce pos_hardware_configs
- [Customer payment allocations](mem://features/customer-payment-allocations.md) — ADR 0027 allocation-first model: usePaymentAllocations / useCustomerLedger are canonical; payments.invoice_id deprecated; DB triggers enforce sum invariant, consistency, period closure
- [Payment reversal](mem://features/payment-reversal.md) — ADR 0012 wizard, intent enum, Customer Deposits primitive, refund rules
- [Attendance enterprise model](mem://features/attendance.md) — Forensic clock RPCs, geofence/selfie/device-trust policies, append-only event log, portal-safe hook split, canonical error codes
- [SoD self-action framework](mem://features/sod-self-action.md) — DB-enforced self-approval/self-benefit guards across payroll/HR/finance/purchasing/sales/inventory; per-org policy + one-time overrides

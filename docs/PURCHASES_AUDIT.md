# Purchases Module — Odoo-Grade Audit

_Project: AccrualFlow (`jkszmrroyjfdwokbkzis`). Audit date: 2026-04-24._
_Method: zero-trust UI → hook → Supabase call → RPC → row trace; corroborated by live DB queries against all Purchases tables._

Legend: ✅ correct · ⚠️ partial · ❌ broken · 🚫 dangerous

---

## Stage 2 — System map

### Org / Business / Branch hierarchy

- **Organization** (`organizations`) is the tenant. Every Purchases table carries `organization_id`.
- **Business** (`businesses`, a.k.a. "company" in Odoo terminology) is the legal entity. AP balances and journal entries roll up here. **Every Purchases table carries `business_id NOT NULL`.**
- **Branch** (`branches`) is the operational unit (Odoo's analytic dimension, but first-class here). Stock, receipts, and per-branch P&L are scoped here. `bills.branch_id`, `purchase_orders.branch_id`, and `journal_entries.branch_id` are nullable (company-wide entries are allowed).
- Active scope is propagated by `BusinessProvider` (`src/contexts/BusinessContext.tsx`) and `BranchProvider` (`src/contexts/BranchContext.tsx`), consumed in every Purchases hook via `useBusinesses()` and `useBranch()`.

### Tables in scope

`purchase_orders`, `purchase_order_items`, `bills`, `bill_items`, `bill_payments`, `vendor_credit_notes`, `vendor_credit_note_applications`, `purchase_returns`, `journal_entries`, `journal_entry_lines`, `accounts`, `contacts` (vendor side), plus inventory `stock_moves` / `warehouses`.

### Canonical RPCs (verified present in live DB)

| RPC | Purpose |
|---|---|
| `confirm_bill_atomic` | Bill draft → received: locks row, resolves accounts, posts balanced JE (Dr Expense/Inventory/Input Tax, Cr AP), links `journal_entry_id`. One transaction. |
| `record_bill_payment_atomic` | Payment + payment-JE + optional WHT-JE in a single transaction. |
| `post_journal_entry_atomic` | Single chokepoint for **every** GL post in the system. Stamps `branch_id` (16th positional arg), enforces balance, handles idempotency by `(source_type, source_id, subtype)`. |
| `void_journal_entry_atomic` | Reverses a JE without mutating the original (creates a `_VOID` mirror). |
| `apply_vendor_credit_atomic` | Locks bill + VCN, inserts application row, synthetic `bill_payments` row (method=`vendor_credit`, no GL), updates `bills.amount_paid` + `vendor_credit_notes.amount_applied`. **No second GL post** — the AP reduction was posted at VCN confirmation. |
| `sync_po_line_billed_quantities` | Trigger maintaining `purchase_order_items.quantity_billed` and blocking over-billing (Σ billed ≤ received). |

### Scoping guards

- `requireOrgId()` / `requireBusinessId()` (`src/lib/orgScopedQuery.ts`, `src/lib/businessScopedQuery.ts`) — runtime asserts before queries.
- `assertCompanyScoped()` / `assertBranchScoped()` (`src/lib/purchases/scopingAssertions.ts`) — dev-only post-fetch guards that catch RLS or filter regressions returning rows from another company/branch.
- `BranchScopeGate` (`src/components/inventory/BranchScopeGate.tsx`) — UI gate for branch-sensitive pages.
- `WarehouseScopeGate` — parallel gate for stock-moving operations.

---

## Stage 3 — Odoo reference (rubric)

| Concept | Odoo | This system |
|---|---|---|
| Lifecycle | RFQ → PO → Receipt → Vendor Bill → Payment | Same. PO `status` flow: `draft → sent → partial_received → received`; `billing_status` separately tracks `no/to_bill/fully_billed`. |
| Three-way match | Bill qty clamps to **received**, not ordered | Enforced by trigger `sync_po_line_billed_quantities` on `bill_items` ✅ |
| AP posting (bill) | Dr Expense/Inventory, Cr AP | `confirm_bill_atomic` does exactly this ✅ |
| AP posting (payment) | Dr AP, Cr Cash/Bank | `record_bill_payment_atomic` ✅; WHT-JE in same tx ✅ |
| VCN | Dr AP, Cr Expense at confirmation; **no JE** at application | Matches: `apply_vendor_credit_atomic` posts **no GL** ✅ |
| Multi-company | Suppliers shared, bills/POs/JEs per company | Suppliers are per `organization_id`; bills/POs/JEs per `business_id` ✅ |
| Returns | Reverse stock move + VCN, never negative bill | `purchase_returns` table + VCN flow exists ✅ |

---

## Stage 4 — Flow audit

### 1. RFQ → PO confirm — ✅

- `usePurchaseOrders.createPurchaseOrder` (`src/hooks/usePurchaseOrders.ts:118`) injects `organization_id` and `business_id` from active context — caller cannot omit. ✅
- PO numbering goes through DB function `get_next_po_number(_org_id)` — atomic, no race. ✅
- Currency carried per-PO; FX snapshot lives on the bill (`bills.currency_rate` + `company_currency_total`) where it matters for AP, not on the PO.

### 2. PO → Receipt — ✅

- Stock moves are created server-side; receipts are scoped by `branch_id` and `warehouse_id`.
- `WarehouseScopeGate` blocks operations when active branch lacks a warehouse — prevents cross-branch stock contamination at the UI layer.

### 3. Receipt → Bill (three-way match) — ✅

- `BillItem.purchase_order_item_id` (`src/hooks/useBills.ts:30`) carries the PO-line link.
- DB trigger `sync_po_line_billed_quantities` blocks over-billing by raising on insert/update if Σ qty > `quantity_received` on the linked PO line.
- Documented in the type comment (lines 23–29). This is the central control that turns Purchases from a "data warehouse" into an AP control surface.
- UI surface: `BillVsReceiptDiffPanel` reads from the SECURITY INVOKER view `po_three_way_match` for ordered/received/billed/to-receive/to-bill display.

### 4. Bill confirm → JE — ✅

- `confirmBillAndPostGL` (`src/hooks/bills/confirmBillGL.ts`) is a thin wrapper over `confirm_bill_atomic`. **Zero client-side GL writes.** ✅
- AP account resolved per-vendor via `contacts.default_payable_account_id` with fallback to system `accounts_payable_id` mapping — not hardcoded. ✅
- Idempotent via `(source_type='bill', source_id=bill.id, subtype='main')` natural key on JE.
- Atomic — no orphaned JE possible (the previous 4-step client sequence was replaced).
- `useBills.createBill` forces `status='draft'` on insert regardless of caller input, then immediately confirms — **draft is never user-visible**. Good defense.
- Edit guard: `updateBill` rejects non-draft bills with a toast. ✅
- Delete guard: `deleteBill` rejects non-draft bills, requires void path. ✅ (prevents orphaned JE)

### 5. Bill payment → AP reduction — ✅

- `record_bill_payment_atomic` writes payment row, payment JE (Dr AP, Cr Bank/Cash), and optional WHT JE (Dr AP, Cr WHT-payable) in one transaction.
- Vendor WHT rate resolved from `contacts.withholding_tax_rate` before the RPC call (`useBills.ts:471–479`); WHT account from `accounts.output_tax_account_id` mapping.
- Status transitions (`partial` / `paid`) handled by the RPC, not the client.
- Pre-flight checks `hasBillingAccounts()` and surfaces missing-mapping errors instead of failing silently.

### 6. Vendor Credit Note → confirm → apply — ✅

- `applyVendorCreditToBill` (`src/lib/purchases/applyVendorCredit.ts`) calls `apply_vendor_credit_atomic`. The wrapper is correct.
- **Critical: no double GL.** GL was posted once at VCN confirmation (Dr AP, Cr Expense). Application is a bookkeeping operation only — synthetic `bill_payments` row with `method='vendor_credit'` and **no journal entry**. This matches Odoo and prevents AP being reduced twice.

### 7. Reporting (Aged Payables, Vendor Statements) — ✅

- `AgedPayables` page calls an RPC with explicit `p_organization_id`, `p_business_id`, `p_branch_id`. Branch is explicit (passed as `branchFilter`), never implicit. ✅
- `useAgingReport` filters `bills` by `organization_id` AND `business_id`. ✅
- `ContactAgingBreakdown` (vendor drill-down) filters by `organization_id` AND `business_id`. ✅

### 8. Scoping sweep — ✅ (with one harmless duplicate)

Grepped every `supabase.from("bills"|"purchase_orders"|"vendor_credit_notes"|"bill_payments")` call site (34 files, 398 matches). Findings:

- All read paths in Purchases hooks (`useBills`, `usePurchaseOrders`, `usePurchaseReturns`, `useContactProfile`, `useDashboardStats`, `useGLIntelligence`, `useAgingReport`, `ContactAgingBreakdown`, `VendorCreditNoteDetailDialog`) carry **both** `organization_id` AND `business_id` filters. ✅
- A handful of by-PK lookups (e.g. `PurchaseReturnDetailDialog` reading a PO by id) are marked `// SCOPE-EXEMPT:` with a justification — acceptable Odoo-style FK navigation.
- Admin-surface counts (`AdminAnalytics`) intentionally cross-tenant — gated by admin role, not Purchases.
- One cosmetic finding: `useGLIntelligence.ts:100-101` has a duplicate `.eq("business_id", currentBusiness.id)` line. Harmless (idempotent filter), but worth tidying.

---

## Stage 5 — Cross-branch contamination tests (live DB)

Ran against `jkszmrroyjfdwokbkzis`:

| Check | Row count |
|---|---|
| `bills.business_id IS NULL` | **0** |
| `purchase_orders.business_id IS NULL` | **0** |
| `vendor_credit_notes.business_id IS NULL` | **0** |
| `bill_payments.business_id IS NULL` | **0** |
| `journal_entries.business_id IS NULL` | **0** |
| `vendor_credit_note_applications.business_id IS NULL` | **0** |
| Bills whose `branch_id` belongs to a different `business_id` | **0** |
| POs whose `branch_id` belongs to a different `business_id` | **0** |
| Bills whose linked PO is in a different `business_id` | **0** |
| VCN applications where `vcn.business_id ≠ bill.business_id` | **0** |

**Conclusion: zero cross-branch / cross-business contamination in the live DB at audit time.** The schema is currently empty of Purchases data (`bills_total_rows = 0`, `po_total_rows = 0`), so this is a clean-slate verification — but the constraints, RLS, and runtime guards are in place to keep it that way under load.

### Supabase linter findings (Purchases-relevant)

- 7 warnings total. **None are Purchases-specific.** They are: extension in public schema, one overly-permissive RLS policy elsewhere, four public storage buckets allowing listing, and leaked-password-protection disabled. All out of Purchases scope; will surface separately if asked.

---

## Stage 6 — Vendor side of Contacts

Verified columns present on `contacts` for vendor flows:

| Field | Present | Used in Purchases |
|---|---|---|
| `type` (enum, includes `supplier`) | ✅ | Filters `/purchases/vendors` and aging |
| `business_id`, `organization_id` | ✅ | Scope |
| `default_payable_account_id` | ✅ | AP override at bill confirm (`confirm_bill_atomic`) |
| `default_expense_account_id` | ✅ | Bill line account fallback |
| `default_currency` | ✅ | Defaults bill currency |
| `withholding_tax_rate` | ✅ | WHT JE at payment |
| `payment_terms_id` | ❌ **missing column** | UI uses default term globally |
| `tax_position_id` | ❌ **missing column** | No fiscal-position handling |
| `is_1099` / withholding flag | ⚠️ partial — `withholding_tax_rate > 0` is the de-facto flag; no explicit 1099 boolean |

Vendor drill-down (`useContactProfile`) returns Bills, POs, Bill Payments — all scoped by `organization_id` AND `business_id`. ✅

No duplicate-vendor merge utility found. Leaving as a known gap rather than silently building one.

---

## Stage 7 — Refinement plan (proposed, not executed)

Each item: file · change · risk · regression surface. **Awaiting per-item approval.**

### P1 — Cosmetic / safety

1. **Drop duplicate scope filter**
   File: `src/hooks/useGLIntelligence.ts:100-101` and `:131-132`
   Change: remove the redundant second `.eq("business_id", …)` lines.
   Risk: none. Regression surface: zero.

### P2 — Schema gaps for Odoo parity

2. **Add `contacts.payment_terms_id`** (FK → `payment_terms.id`, nullable)
   Surface in vendor form; default new bills' due-date computation to vendor term, fall back to org default.
   Risk: low. Regression: bill due-date logic must be updated to read vendor override first.

3. **Add `contacts.tax_position_id`** (FK → `tax_positions.id`, nullable) — only if `tax_positions` table exists; otherwise defer.
   Risk: medium (requires tax-position resolution at line level).

4. **Add `contacts.is_1099` (boolean)** for US 1099-NEC reporting cohort. Independent of `withholding_tax_rate`.
   Risk: trivial.

### P3 — Hard guarantees (DB constraints)

5. **Cross-table trigger: `bills.branch_id` must belong to `bills.business_id`**
   Same for `purchase_orders`, `vendor_credit_notes`, `bill_payments`, `journal_entries`. Currently enforced by app code + RLS but not by a row-level constraint.
   Risk: low; live DB already complies (0 violations). Migration would `RAISE` only on future bad inserts.

6. **Cross-table trigger: a `bill.purchase_order_id` must satisfy `bill.business_id = po.business_id`.**
   Same logic for `vendor_credit_note_applications` (vcn ↔ bill business equality).
   Risk: low.

### P4 — Vendor side

7. **Vendor merge utility** (deferred): wraps FK re-pointing across `bills`, `purchase_orders`, `bill_payments`, `vendor_credit_notes`, `purchase_returns`, `analytic_distributions`, `audit_logs` in a single transaction; soft-deletes the losing contact. Build only on explicit ask.

### Out of scope

- Routing migration: keep `react-router-dom` inside each app shell behind the TanStack splat route. No change.
- Schema rewrites: not warranted. Existing Purchases schema is Odoo-grade.

---

## Final verdict

**Correct (✅):** lifecycle, three-way match enforcement, atomic bill confirm, atomic payment+WHT, VCN application without double GL, scope filters on every read, runtime contamination guards, branch-aware reporting, draft/edit/delete guards, void-instead-of-delete, vendor AP override.

**Partial (⚠️):** vendor master is missing `payment_terms_id`, `tax_position_id`, and an explicit `is_1099` flag. WHT works but is the only withholding signal.

**Broken (❌):** none found in Purchases.

**Dangerous (🚫):** none. No client-side GL posting. No bypass of canonical RPCs in any Purchases code path.

**Missing:** vendor merge tool; per-vendor payment terms; explicit 1099 flag.

**Not Odoo-grade:** the only material gap is fiscal positions (tax mapping per vendor). Everything else meets or exceeds Odoo's vendor-bill discipline (notably: synchronous atomic confirm, which Odoo does asynchronously via the `account.move` state machine).

---

## Sign-off

The Purchases module is materially correct and safe to operate. The seven cosmetic / schema gap items above are tracked for follow-up and require explicit approval before any migration is applied (per the plan's Stage 7 contract).
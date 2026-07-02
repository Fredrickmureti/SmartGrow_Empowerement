# Full Accounting Product Audit Report
## Date: 2026-03-08

---

## EXECUTIVE SUMMARY

The accounting system has a **solid architectural foundation** (double-entry GL, atomic RPCs, accrual-based reporting, modular app structure). However, it suffers from **workflow disconnections, missing accountant-grade features, poor discoverability, and incomplete navigation flows** that make it feel like a developer tool rather than a polished accounting product.

**Overall Maturity Rating: 55/100** (compared to QuickBooks ~92, Xero ~90, Odoo ~85)

---

## PHASE 1: MODULE-BY-MODULE AUDIT

### 1. CHART OF ACCOUNTS ⚠️ HIGH PRIORITY

**What Exists:** Account types, detail types, sub-accounts, import/export, archive, summary cards, accordion grouped view.

**Critical Gaps:**
| Issue | Severity | Benchmark |
|-------|----------|-----------|
| **No "View Register" / "Account History"** — clicking an account does nothing, no way to see transactions for a specific account. QuickBooks shows account register on click. | 🔴 CRITICAL | QB, Xero, Odoo all have account registers |
| **No "Run Report" action per account** — cannot jump to GL filtered for this account | 🔴 CRITICAL | QB has "Run Report" in action menu |
| **No batch edit** — QB allows batch editing multiple accounts at once | 🟡 MEDIUM | QB Online has batch edit |
| **No account number toggle** — QB allows showing/hiding account numbers globally | 🟢 LOW | QB preference |
| **Detail type badge shown but not filterable** — no filter by detail type | 🟡 MEDIUM | QB has filter by detail type |
| **Opening balance not shown in table** — only current balance visible | 🟡 MEDIUM | Both QB and Xero show this |
| **No "Make Inactive" / "Make Active" wording** — uses "Archive" which isn't accounting terminology | 🟡 MEDIUM | QB uses "Make inactive" |
| **No print/PDF export of Chart of Accounts as report** | 🟡 MEDIUM | QB exports to PDF/print |

### 2. CONTACTS / CUSTOMERS / SUPPLIERS ⚠️ HIGH PRIORITY

**What Exists:** Unified contacts page, type filters, import/export, credit management, bulk operations, customer groups, paginated.

**Critical Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **🔴 Purchases Vendors route doesn't filter to suppliers** — `<Contacts />` rendered without `defaultTypeFilter="supplier"` in purchases/routes.tsx line 115 | 🔴 CRITICAL | Shows ALL contacts instead of vendors only |
| **🔴 "Add Supplier" creates generic contact** — no pre-filled type, user must manually select "supplier" from type dropdown | 🔴 CRITICAL | Should auto-set type from context |
| **🔴 Post-create flow doesn't pass contact_id** — toast says "Create Invoice" but navigates without contact_id, so the invoice form isn't pre-filled | 🔴 CRITICAL | Broken contextual flow |
| **No contact detail page** — no dedicated page showing contact's invoices, bills, payments, statements, balance | 🟡 HIGH | QB, Xero, Odoo all have this |
| **No "Account Receivable/Payable" balance shown per contact** | 🟡 HIGH | QB shows open balance in contacts list |
| **No vendor portal for bill submission** referenced but portal exists | 🟢 LOW | Nice-to-have |

### 3. GLOBAL "+ CREATE" MENU ⚠️ MEDIUM PRIORITY

**What Exists:** Categorized dropdown with Customers, Suppliers, Team, Other sections.

**Critical Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **Missing "Expense" in Suppliers section** — most common purchase action missing | 🔴 CRITICAL | QB has Expense as first supplier item |
| **Missing "Estimate" in Customers section** | 🟡 HIGH | QB has Estimate |
| **Missing "Sales Receipt"** in Customers section | 🟡 MEDIUM | QB has this |
| **"Receive Payment" routes to /sales/payments** which may not have ?action=create handling | 🟡 MEDIUM | Needs verification |
| **No "Pay down credit card" equivalent** | 🟢 LOW | QB-specific feature |

### 4. JOURNAL ENTRIES ⚠️ MEDIUM PRIORITY

**What Exists:** Create/edit/delete, status workflow (draft/posted/voided), AccountCombobox, import, subscription-gated.

**Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **No recurring journal entries** | 🟡 HIGH | QB, Xero, Odoo all support this |
| **No reversing entries** (auto-reverse on a future date) | 🟡 HIGH | Standard accounting feature |
| **No attachment upload on JE** (mentioned in plan but needs verification) | 🟡 MEDIUM | Audit requirement |
| **No "Copy" / "Duplicate" action** | 🟡 MEDIUM | Very common action |

### 5. INVOICES ✅ GOOD (minor issues)

**What Exists:** Full CRUD, status workflow, payments, PDF/print, email, import/export, recurring, paginated, multi-view.

**Minor Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **No deposit/advance payment on invoice** | 🟡 MEDIUM | QB has this |
| **No "Convert to recurring" action** from existing invoice | 🟢 LOW | Convenience feature |

### 6. BILLS ⚠️ MEDIUM PRIORITY

**What Exists:** Full CRUD, payment recording, status workflow, import/export.

**Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **No "Pay Multiple Bills" workflow** — batch payment to one vendor | 🟡 HIGH | QB has "Pay Bills" screen |
| **No bill payment method integration** (check printing, bank transfer) | 🟡 MEDIUM | QB prints checks |
| **No recurring bills** | 🟡 MEDIUM | Missing feature |
| **No bill approval workflow** (exists in approval system but not surfaced in bills UI) | 🟢 LOW | Enterprise feature |

### 7. BANKING & RECONCILIATION ⚠️ MEDIUM PRIORITY

**What Exists:** Bank accounts, transaction import, reconciliation, AI matching.

**Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **No "Bank Rules"** for automatic categorization based on description patterns | 🟡 HIGH | Xero's killer feature |
| **No "Cash Coding"** — batch categorize multiple transactions at once | 🟡 HIGH | Xero feature |
| **No bank statement reconciliation report** (formal statement) | 🟡 MEDIUM | Audit requirement |
| **Reconciliation doesn't show matched vs unmatched side-by-side** | 🟡 MEDIUM | Xero's split-screen approach |

### 8. REPORTS ⚠️ HIGH PRIORITY

**What Exists:** P&L (accrual-based), Balance Sheet, Trial Balance, GL, Aging, Cash Flow, Partner Ledger, Journal Report, Sales Reports, Tax Reports, Budget Reports, Stock Reports, Depreciation, Audit Trail, Management Reports, BI.

**This is actually quite comprehensive.** The issue is DISCOVERY and PRESENTATION.

**Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **No unified Report Center/Index** with categorized listing | 🟡 HIGH | QB has a Reports page listing all available reports with search |
| **Reports not accessible from CoA per-account** | 🔴 CRITICAL | Need "Run Report" from account actions |
| **No "Favorite Reports" / "Frequently Used"** | 🟢 LOW | QB feature |
| **No custom date range picker** — only preset ranges | 🟡 HIGH | QB/Xero allow custom from-to |
| **No comparison periods** (this period vs last period) | 🟡 HIGH | Standard reporting feature |
| **No "Customer Balance Summary" standalone report** | 🟡 MEDIUM | QB standard report |
| **No "Vendor Balance Summary" standalone report** | 🟡 MEDIUM | QB standard report |
| **No "Account List" printable report** (CoA as formal report) | 🟡 MEDIUM | QB standard report |

### 9. PAYMENTS & RECEIPTS ✅ GOOD

**What Exists:** Atomic payment recording, receipt generation, void/unreconcile/reapply, payment methods, import.

**Minor Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **No "Receive payment" from invoice directly** (exists but flow may be broken) | 🟡 MEDIUM | Check invoice action menu |
| **No standalone payment entry** without selecting invoice first | 🟡 MEDIUM | QB allows unapplied payments |

### 10. EXPENSES ✅ GOOD

**What Exists:** Full CRUD, categories, vendor linking, approval workflow, paginated, import/export, multi-view.

**Good module.** One gap: not in GlobalCreateMenu.

### 11. TAXES ⚠️ MEDIUM

**What Exists:** Tax rates, fiscal localization, eTIMS integration, tax account mappings.

**Gaps:**
| Issue | Severity | Description |
|-------|----------|-------------|
| **No tax group/compound tax** (multiple taxes applied as group) | 🟡 MEDIUM | Odoo feature |
| **Tax reports may not auto-calculate from GL** | 🟡 MEDIUM | Need to verify |

### 12. SETTINGS / CONFIGURATION ✅ ADEQUATE

**What Exists:** Default accounts, payment terms, payment methods, fiscal periods, receipt settings, currency, fiscal localization.

---

## PHASE 2: WORKFLOW FRICTION ANALYSIS

### Critical Broken Workflows

1. **🔴 "Add Supplier" from GlobalCreateMenu → Goes to /contacts-app/contacts → Shows ALL contacts, not vendor-filtered → Type not pre-set to "supplier"** — User has to navigate, then manually select supplier type. QuickBooks: click "Add Supplier" → supplier form opens immediately.

2. **🔴 "Add Customer" from GlobalCreateMenu → Same issue** — navigates to contacts page, not supplier-filtered, no type pre-set.

3. **🔴 Purchases Vendors Page Shows All Contacts** — `purchases/routes.tsx` line 115 renders `<Contacts />` without `defaultTypeFilter="supplier"`, so users see customers mixed with vendors.

4. **🔴 Post-create contact → "Create Invoice" toast → Navigates without contact_id** — The contact is created successfully, the toast offers to create an invoice, but clicking it goes to `/sales/invoices?action=create` WITHOUT the contact_id, so the invoice form opens with no customer pre-selected. Totally defeats the purpose of the contextual flow.

5. **🟡 Chart of Accounts → No way to see account transactions** — An accountant's #1 action is clicking an account to see its register/ledger. Our system has no path from CoA to transaction history.

6. **🟡 No quick "Record Payment" on invoice row** — The action exists in the dropdown but is buried. QB shows a big "Receive Payment" button.

### Unnecessary Click Analysis

| Workflow | Current Clicks | Ideal Clicks | Issue |
|----------|---------------|-------------|-------|
| Create supplier | 4+ (navigate → click Add → select type → fill) | 2 (click Add Supplier → fill form) | Type should be pre-set |
| View account transactions | Impossible from CoA | 1 click | Missing feature |
| Run GL for specific account | Navigate to GL → select account filter | 1 click from CoA | Missing action |
| Pay a bill | Find bill → open → click Pay | Should be possible from bill list | OK but could be better |

---

## PHASE 3: COMPETITIVE GAP MAPPING

| Feature | Our System | QuickBooks | Xero | Odoo | Gap Level |
|---------|-----------|------------|------|------|-----------|
| Account Register/History | ❌ Missing | ✅ Core | ✅ Core | ✅ Core | 🔴 Critical |
| Run Report from Account | ❌ Missing | ✅ Per-account | ✅ | ✅ | 🔴 Critical |
| Contact Detail Page | ❌ Missing | ✅ Full profile | ✅ Full | ✅ Full | 🟡 High |
| Global Create Menu | ✅ Good | ✅ Excellent | ❌ Different UX | ✅ Good | ✅ Parity |
| Bank Rules | ❌ Missing | ✅ | ✅ Killer feature | ✅ | 🟡 High |
| Batch Payment | ❌ Missing | ✅ "Pay Bills" | ✅ Batch pay | ✅ | 🟡 High |
| Report Center | ⚠️ Scattered | ✅ Centralized | ✅ Centralized | ✅ | 🟡 High |
| Recurring JE | ❌ Missing | ✅ | ✅ | ✅ | 🟡 High |
| Custom Date Range | ❌ Presets only | ✅ Full | ✅ Full | ✅ Full | 🟡 High |
| Chart of Accounts Print/PDF | ❌ Only CSV | ✅ PDF/Print | ✅ | ✅ | 🟡 Medium |
| Comparison Reports | ❌ Missing | ✅ Prior period | ✅ Budget comp | ✅ | 🟡 High |
| Double-entry GL | ✅ Correct | ✅ | ✅ | ✅ | ✅ Parity |
| Accrual-based P&L | ✅ Journal-based | ✅ | ✅ | ✅ | ✅ Parity |
| Multi-currency | ✅ Good | ✅ | ✅ | ✅ | ✅ Parity |
| Fiscal Periods | ✅ | ✅ | ✅ | ✅ | ✅ Parity |
| Fixed Assets & Depreciation | ✅ | ✅ Plus | ✅ | ✅ | ✅ Parity |
| Import/Export | ✅ Good | ✅ | ✅ | ✅ | ✅ Parity |

---

## PHASE 4: ARCHITECTURE & DATA FLOW REVIEW

### Strengths ✅
- Atomic RPCs for payments (no partial state)
- Double-entry enforced at GL level
- Accrual-based reporting from journal entries
- Modular app architecture with proper permission gating
- Subscription-tier feature gating
- Audit logging infrastructure

### Weaknesses ⚠️
- **No account register view** — GL data exists but no UI to view per-account
- **Contact → Transaction linkage is one-way** — invoices have contact_id but there's no contact detail page aggregating all transactions
- **Report engine is fragmented** — each report is its own page with different patterns, no shared report shell component
- **No shared document viewer/editor pattern** — invoices, bills, JEs all have their own dialog patterns (not consistent)
- **State management mixes useState with react-query** — some hooks use useState+useEffect (payments, bank transactions) while others use react-query properly

---

## PHASE 5: MISSING FEATURES DISCOVERY

### Features That Should Exist But Don't

1. **Account Register Page** — View all transactions for a specific account with running balance
2. **Contact Detail/Profile Page** — Aggregated view of all customer/vendor activity
3. **Report Center** — Centralized hub listing all available reports with categories & search
4. **Bank Rules Engine** — Auto-categorize bank transactions based on patterns
5. **Batch Payment Processing** — Pay multiple vendor bills in one flow
6. **Recurring Journal Entries** — Auto-generate JEs on a schedule
7. **Reversing Journal Entries** — Mark a JE to auto-reverse on a future date
8. **Custom Date Range Picker** — Allow user-defined from/to dates on all reports
9. **Comparison Reports** — Compare current period to prior period or budget
10. **Duplicate/Copy actions** — Copy an invoice, JE, bill, estimate to create new
11. **Customer/Vendor Balance Summary Reports** — Standalone AR/AP reports by contact
12. **Chart of Accounts as Printable Report** — Formal CoA listing
13. **Unapplied Payments** — Record payments before matching to invoices
14. **Bank Reconciliation Statement** — Formal reconciliation report for auditors

---

## PHASE 6: PRIORITIZED IMPLEMENTATION ROADMAP

### 🔴 CRITICAL (Implement Now — blocks basic accounting usability)

1. **Fix Purchases Vendors route** — add `defaultTypeFilter="supplier"` 
2. **Fix GlobalCreateMenu "Add Supplier"/"Add Customer"** — pass type parameter, pre-set form type
3. **Fix post-create contact flow** — pass contact_id to invoice/bill creation
4. **Add "View Register" action to Chart of Accounts** — link to GL filtered by account
5. **Add "Run Report" action to Chart of Accounts** — link to GL report for account
6. **Add "Expense" to GlobalCreateMenu Suppliers section**
7. **Add "Estimate" to GlobalCreateMenu Customers section**

### 🟡 HIGH (Implement Soon — major competitive gap)

8. **Account Register page** — dedicated page showing account transaction history
9. **Report Center** — unified reports hub with categories
10. **Custom date range picker** on reports
11. **Contact Detail Page** — aggregated contact view
12. **Bank Rules** for auto-categorization
13. **Batch Pay Bills** workflow

### 🟢 MEDIUM (Plan for next sprint)

14. Recurring JEs
15. Reversing JEs
16. Comparison reports
17. CoA print/PDF report
18. Duplicate/Copy actions across modules
19. Contact open balance in list view

---

## WHAT I WILL IMPLEMENT NOW

Given the critical nature of items 1-7, I will implement all 7 critical fixes in this session, plus the Account Register link (item 8 partial — linking from CoA to GL filtered by account).

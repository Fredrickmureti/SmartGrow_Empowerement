# Landed Cost — Domain Reconstruction

## What Landed Cost actually is

Landed cost is not a page and not a bill type. It is a **value-only correction to the acquisition cost of already-received inventory**: costs incurred to bring goods to their point and condition of sale (freight, duty, insurance, handling, brokerage, port, clearing) that are directly attributable to a receipt and therefore capitalizable into inventory, rather than expensed.

That means the domain's real output is not a document. It is two effects:

1. an **inventory valuation adjustment** (cost layers gain value without gaining quantity), and
2. a **journal** (Inventory asset debited, a landed-cost clearing/accrual credited, settled by the freight/duty AP bill).

Everything else — the header, components, allocation basis, workspace — exists only to produce those two effects deterministically and reversibly.

Ownership: **Purchasing owns the document and the allocation. Inventory owns valuation. Finance owns the ledger.** Landed Cost must never compute valuation or accounting itself; it must call the canonical engines.

## Audit verdicts (evidence-based)

| Area | Verdict | Evidence |
|---|---|---|
| Tables + RLS (`landed_cost_bills`, `landed_cost_allocations`) | ⚠ Usable skeleton, wrong shape | Single-component header: `cost_type` is a column, so one bill cannot carry freight + duty + insurance. No shipment/voucher concept, no period/posting date, no FX rate, no approval link. |
| Lifecycle | ⚠ Exists but unenforced | `draft → allocated → posted → reversed` exists in a CHECK constraint; the UI flips `posted` with a raw browser `UPDATE` (`src/pages/purchases/LandedCosts.tsx:99-106`), bypassing the state machine entirely. |
| Allocation engine | ⚠ Partial | `allocate_landed_cost_bill` supports `quantity` and `value` only; `weight` and `manual` are permitted by the CHECK and rejected at runtime. It allocates over **every** GRN line in the business when no receipts are passed, ignores product eligibility, ignores UoM, and uses `quantity_received × poi.unit_price` rather than the receipt's own per-base-unit cost (contradicting ADR 0024). |
| Inventory valuation | ❌ Architecturally wrong | `post_landed_cost_bill` writes `stock_movements` rows with `quantity = 0`. `_maintain_cost_layers()` early-returns on `abs(quantity) = 0`. **No cost layer, no AVCO, no unit cost is ever changed.** ADR 0077 cites a trigger `trg_update_wac_on_receipt` that does not exist. Posting is inert. |
| Accounting / GL | ❌ Missing | No landed-cost function references `post_journal_entry_atomic`, `default_account_settings`, or `journal_entries`. Inventory is never debited, no clearing account exists, the freight bill's expense never reverses out. Silent violation of ADR 0123's intent. |
| FX | ❌ Missing | `currency text DEFAULT 'USD'`, never resolved through `resolve_exchange_rate`/`require_exchange_rate`; no rate or rate date stored. Violates ADR 0136. |
| UoM | ❌ Missing | No `_uom_normalize_line` usage; allocation basis mixes UoMs across lines. |
| Approvals | ❌ Missing | No `approval_route`; posting gated only by a role check. |
| Reversal | ⚠ Ad-hoc | `reverse_landed_cost_bill` reverses inert movements; does not use `reversal_approval_requirement` / `assert_can_reverse`, and has no journal to reverse. |
| Events / audit | ❌ Missing | No `business_event_outbox` emission (contrast `complete_goods_receipt_atomic`, the canonical emitter). No activity feed. |
| Documents | ❌ Missing | No `document_kinds` row for landed cost; no print/download/email path. |
| Workspace / UI | ❌ Missing | One 200-line page, inline `supabase.from()`, hand-rolled `<table>`, no hook, no service layer, no `RecordScaffold`/`PeekScaffold`, no create action, `post`/`reverse` RPCs orphaned (zero frontend callers). Mis-filed under nav group "Insights". |

**Root cause of the empty page: the domain was never completed.** Nothing creates a landed-cost record (no "convert bill" action exists), so the list is correctly empty — and even if populated, posting would change nothing.

## Target model

```
Landed Cost Voucher (header: shipment ref, supplier(s), posting date, period, currency + stamped FX rate, status)
  └─ Cost Components      (freight | duty | insurance | handling | brokerage | port | clearing | other,
                           each with its own amount, currency, source AP bill line, expense/clearing account role,
                           allocation basis, and capitalize-vs-expense treatment)
       └─ Allocation Targets   (eligible GRN lines across one or many GRNs / POs / suppliers / warehouses)
            └─ Allocation Results  (basis value, ratio, allocated amount, capitalized vs expensed split)
                 ├─ Inventory effect  → canonical cost-layer revaluation
                 └─ Accounting effect → post_journal_entry_atomic
```

Component types become **configurable rows** bound to account roles, not a hardcoded CHECK list — no country's customs vocabulary in the engine. Eligibility comes from the product/inventory domain (stocked, valuation-eligible product types only); services, expense purchases and non-stock lines are excluded, never silently absorbed.

## The missing foundation

Value-only revaluation does not exist in the inventory engine. This is the prerequisite everything else waits on:

`inventory_apply_cost_revaluation(product, warehouse, source_layer/receipt, amount)` must
- add value to the **remaining** quantity of the receipt's cost layers (raising `unit_cost`, quantity untouched),
- route the share attributable to quantity **already consumed** (sold, transferred, scrapped) to a cost-variance/COGS adjustment instead of capitalizing it into stock that no longer exists,
- be idempotent per (source, layer) and fully reversible,
- return the capitalized/expensed split so the journal builder can post it.

Without this, no landed cost can ever be correct.

## Reconstruction plan (dependency-ordered)

1. **Foundation** — `inventory_apply_cost_revaluation` + its reversal, inside the inventory valuation engine, with consumed-quantity handling and cost-layer provenance rows.
2. **Domain model migration** — new `landed_cost_vouchers` / `landed_cost_components` / `landed_cost_allocations` with FX rate stamping, posting date + fiscal period, approval link, configurable component-type catalog bound to account roles. Migrate/retire `landed_cost_bills` (no production data; consolidate rather than shim) and drop the inert `movement_type = 'landed_cost'` zero-quantity path.
3. **Eligibility + allocation engine** — receipt selection across multi-GRN / multi-PO / multi-supplier / multi-warehouse, product eligibility from the inventory domain, bases quantity / value / weight / volume / manual, all normalized through the canonical UoM engine, value basis taken from the receipt's per-base-unit cost (ADR 0024), deterministic rounding.
4. **FX** — resolve and stamp the rate via `require_exchange_rate` at posting date; refuse to post an unresolved pair rather than assuming parity (ADR 0136).
5. **Accounting boundary** — `finance_post_landed_cost_journal` resolving Inventory / clearing / duty / freight-expense accounts through `default_account_settings`, posting a single balanced entry through `post_journal_entry_atomic` (ADR 0123). Fiscal-period lock enforced; a landed cost arriving after the GRN's period is closed posts to the open period, not the receipt's.
6. **Posting orchestration** — `post_landed_cost_voucher` mirroring `complete_goods_receipt_atomic`: lock → valuation subscriber → journal subscriber → status → single `business_event_outbox` emission (`procurement.landed_cost.posted`), idempotent by voucher id.
7. **Governance** — route posting through `approval_route` (ADR-0101) with an action key in `governance_action_registry`; mirror the decision back onto the voucher.
8. **Reversal & correction** — reversal through the canonical `reversal_approval_requirement` → `assert_can_reverse` → `request_reversal_approval` gate, reversing valuation and journal together. Supplier credit note / duty refund / freight refund enter as negative components on a new voucher, never as edits to a posted one. No destructive deletion.
9. **Edge lifecycle** — cost arriving before receipt (accrue, allocate on receipt), partial receipts, cancelled/returned receipts, disputed costs, inventory already sold or transferred.
10. **Documents** — register a `purchases.landed_cost` document kind with its own profile and header vocabulary (never "Bill To" / "Invoice"), wired through the canonical rendering pipeline.
11. **Operational workspace** — rebuild as a feature module (`src/features/purchases/landed-cost/`) following the Bills/GRN pattern: query hooks, RPC-only action layer, `RecordScaffold` + `PeekScaffold` from the records design system, `useDocumentActivity` audit feed, print/download/email. Surfaces real operational state: receipts awaiting allocation, drafts, awaiting approval, ready to post, posted, reversed, allocation exceptions, unresolved costs near period close, and the inventory value actually moved. Every figure sourced from the canonical tables — no fabricated KPIs. Move nav from "Insights" to Operations, and hide the surface for businesses with no stocked inventory.
12. **Reporting** — landed cost by product / receipt / shipment / supplier, capitalization vs expensed, clearing-account balance, cost-per-unit before and after, all as projections over the ledger and cost layers; no parallel reporting tables.
13. **Guards & tests** — architecture ratchets: no direct writes to landed-cost tables from the browser, no journal insert outside the engine, no second FX/UoM/valuation path, plus unit tests on allocation determinism, rounding, consumed-inventory split, and reversal symmetry.
14. **ADR 0077 superseded** by a new ADR recording the corrected model and the removal of the zero-quantity movement design.

## Note on scope

This is a large multi-session rebuild. Steps 1–6 are the trustworthy core: until they land, any workspace work would decorate an inert domain. I will build in that order and report at each boundary.

# POS Operational-State & Touch-First Benchmark Rubric

Implementation-neutral audit rubric for terminal UX, derived from surveying mature
enterprise/retail POS platforms. Use to score *any* POS terminal (including this
project's Enerpize-like pattern) on architecture and workflow maturity — not visual
styling.

## Sources reviewed

- Oracle Retail Xstore POS — Suspend/Resume/Modify Transaction, User Guide
  - https://docs.oracle.com/en/industries/retail/retail-xstore-point-of-service/21.0/rpxug/suspend-transaction.htm
  - https://docs.oracle.com/en/industries/retail/retail-xstore-point-of-service/21.0/rpxug/resume-transaction.htm
  - https://docs.oracle.com/en/industries/retail/retail-xstore-point-of-service/22.0/rpxug/modify-transaction.htm
- NCR Voyix Advanced Store — Tendering, Accepting Payments, Authorization Overrides, Void Partial Tenders
  - https://onlinehelp.ncrvoyix.com/Retail/Solutions/AdvancedStore/Release_6.8_R34/HTML/Topics/EOM-Reference/3-POSOptions/10-StoreSetup/2-AuthOverrides.htm
  - https://onlinehelp.ncrvoyix.com/Retail/Solutions/AdvancedStore/Release_6.8_R35/HTML/Topics/POS-Features/2-SalesFunctions/13-AcceptPayments/1-Overview/1-AcceptPayments-Overview.htm
  - https://onlinehelp.ncrvoyix.com/Retail/Solutions/AdvancedStore/Release_6.8_R34/HTML/Topics/EOM-UserGuide/2-OptionsByFeature/16-Tendering.htm
  - https://onlinehelp.ncr.com/Retail/Solutions/AdvancedStore/Release_6.8_R35/HTML/Topics/POS-Features/2-SalesFunctions/15-VoidPartialTenders/1-VoidPartialTenders.htm
- Microsoft Dynamics 365 Commerce POS — Returns, Suspend/Recall Transaction, Refund Policy, Order Recall
  - https://learn.microsoft.com/en-us/dynamics365/commerce/pos-returns
  - https://github.com/MicrosoftDocs/Dynamics-365-Unified-Operations-Public/blob/main/articles/commerce/pos-suspend-recall-transactions.md
  - https://learn.microsoft.com/en-us/dynamics365/commerce/refund_policy_returns
  - https://github.com/MicrosoftDocs/Dynamics-365-Unified-Operations-Public/blob/live/articles/commerce/enhancedorderrecall.md
- Shopify POS — Offline Payments/Checkout, Returns & Refunds, Receipt Management, Order Management
  - https://help.shopify.com/en/manual/sell-in-person/shopify-pos/selling-offline/offline-payments
  - https://help.shopify.com/en/manual/sell-in-person/shopify-pos/selling-offline/offline-checkout
  - https://help.shopify.com/en/manual/sell-in-person/shopify-pos/order-management/complete-refund-orders
  - https://help.shopify.com/en/manual/sell-in-person/shopify-pos/receipt-management/managing-receipts
  - https://help.shopify.com/en/manual/sell-in-person/shopify-pos/order-management
- W3C WCAG — Target Size (Minimum, AA / Enhanced, AAA)
  - https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum
  - https://w3c.github.io/wcag/understanding/target-size-enhanced.html
  - https://dequeuniversity.com/resources/wcag2.1/2.5.5-target-size

## Cross-platform patterns observed

1. **Stable terminal shell** — the register/sale screen is a persistent frame; sub-workflows
   (tender, returns, suspend list) are presented as overlays or state transitions *on top of*
   the shell, not full navigations that lose context (Xstore returns to "Register screen" after
   suspend; NCR tender is a modal-like screen over the sale).
2. **Suspend/resume as first-class state, not a discard** — cart contents survive a deliberate
   pause (Xstore, D365 Commerce) with an addressable ticket (barcode/number) for later recall,
   including recall on a different register.
3. **Dedicated, separated refund/return state** — returns are a distinct transaction mode with
   its own screen and rules (line-level, reason codes, restock decision) rather than a variant
   of the sale cart (D365 `pos-returns`, Shopify `complete-refund-orders`).
4. **Dedicated payment/tender workspace** — tendering is isolated from item entry: multiple
   tender types, split/partial tender, void-partial-tender before completion, and authorization
   overrides gated by role (NCR Tendering, Accepting Payments, Void Partial Tenders, Authorization
   Overrides).
5. **Cashier/manager override as an interruption pattern** — sensitive actions (price override,
   voids, auth) trigger a role-gated prompt inline, without abandoning the in-progress
   transaction (NCR Authorization Overrides — role-based, configurable per function).
6. **Receipt/history as read/append, not destructive** — receipt reprint, refund, exchange, and
   notes operate against an immutable order record separate from the live cart (Shopify Orders
   screen: reprint, refund, exchange, additional payment all hang off one order entity).
7. **Offline as a graceful degrade, not a dead end** — cash/manual tenders keep working offline;
   card auth is deferred/queued and reconciled on reconnect (Shopify offline checkout / offline
   payments split by tender type).
8. **Product info lookup is non-blocking** — item/price lookup happens without leaving or
   clearing the active sale.
9. **Fixed, always-visible summary** — running total/tender-due/change region is pinned and
   persists across state changes (tender, return, suspend) so the cashier never loses the number
   that matters.
10. **Touch-first input** — target sizing and keypad/keyboard entry are tuned for gloved/imprecise
    touch and glanceable feedback, aligned with WCAG 2.5.8 (AA, ≥24×24 CSS px with spacing) and
    2.5.5 (AAA, ≥44×44 CSS px) as a baseline, exceeding it for primary transactional controls
    (tender buttons, numeric keypad, complete-sale).

## Benchmark rubric

Score each dimension 0–3 (0 = absent, 1 = ad hoc, 2 = mostly consistent, 3 = fully consistent
with pattern). Total /30.

| # | Dimension | 0 | 1 | 2 | 3 (target) |
|---|---|---|---|---|---|
| 1 | Terminal shell stability | Full page reloads/navigations for sub-flows | Some flows overlay, others navigate away | Most sub-flows overlay the shell | Sale, tender, return, suspend-list all render as state changes within one persistent shell |
| 2 | Suspend/resume integrity | No suspend, or suspend clears cart | Suspend exists but loses items/customer | Suspend preserves cart, no recall id | Suspend preserves full cart/customer state with an addressable ticket, resumable from any register |
| 3 | Refund/return isolation | Refund reuses sale-cart UI ad hoc | Refund is a mode flag on same screen | Refund has its own screen but shares logic loosely | Refund is a dedicated workspace: line selection, reason codes, restock choice, distinct from active sale |
| 4 | Payment/tender workspace | Tender inline in cart list | Tender is a modal but limited to single tender | Tender supports split tender only | Dedicated tender workspace: multi-tender, partial-tender void, change calc, all before commit |
| 5 | Cashier/manager override | No role gating on sensitive actions | Gating exists but interrupts/abandons transaction | Gating present, inconsistent UI | Inline, role-gated prompt (PIN/approval) that resumes exact prior state on approval/denial |
| 6 | Receipt/history model | No history access from terminal | History view exists but is read-only dead end | History supports reprint only | History supports reprint, refund, exchange, notes against immutable order record, without disturbing live cart |
| 7 | Offline resilience | Terminal fully blocks when offline | Cash-only offline, no reconciliation path | Offline queues transactions but no visible sync state | Tender-aware offline degrade (cash/manual continue, card deferred) with visible sync/reconciliation state |
| 8 | Product info lookup | Requires leaving/clearing sale to look up item | Lookup possible but clears cart | Lookup in overlay but blocks input | Non-blocking lookup overlay/panel; cart and focus preserved |
| 9 | Fixed summary/totals | Totals scroll out of view | Totals visible only on cart screen | Totals visible in most but not all states | Totals/change-due region pinned and visible across sale, tender, return, suspend states |
| 10 | Touch-first input & keypad | Small mixed touch/mouse targets, keyboard-only entry | Some large targets, no numeric keypad | Meets WCAG 2.5.8 (≥24×24px, spaced) | Primary transactional controls ≥44×44px (WCAG 2.5.5), dedicated numeric keypad, keyboard shortcuts as secondary path |

### Scoring guidance

- **24–30**: enterprise-parity operational-state model.
- **16–23**: functional but has state-loss or role-gating gaps likely to cause cashier errors or training overhead.
- **≤15**: architecture treats sub-flows as navigations rather than states; prioritize items 1–4 first (shell stability, suspend integrity, refund isolation, tender workspace) as they are prerequisites for the rest.

### How to apply to this project's terminal

For the Enerpize-like pattern already in place (stable shell + in-place receipts workspace
preserving cart + dedicated refund state + dedicated payment workspace), score dimensions 1–4 as
largely satisfied by design intent, then audit implementation against 5–10 (override
interruption behavior, receipt/history immutability, offline degrade, product lookup
non-blocking-ness, pinned summary persistence, and concrete touch-target sizing in CSS) to find
the remaining gaps.

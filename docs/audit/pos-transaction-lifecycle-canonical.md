# POS Transaction Engine — Canonical Enterprise Lifecycle

Date: 2026-07-18
Status: Reference — the lifecycle we hold ourselves to for Phase 3.
Feeds ADR 0082.

The canonical enterprise retail transaction lifecycle, inferred from the
architectural principles shared by mature retail platforms (SAP Customer
Checkout, Oracle Retail, Microsoft Dynamics 365 Commerce, NCR Retail,
LS Central, Odoo POS). This is not a copy of any single implementation —
it is the shape a POS transaction engine must express to be trustworthy
as a canonical retail transaction orchestrator.

## Canonical stages

```text
        Customer arrives
              │
              ▼
        Basket created                       ← identity, tax context
              │
              ▼
        Products added                       ← by scan / lookup / catalog
              │
              ▼
        Product resolution                   ← authoritative product data
              │
              ▼
        Pricing resolution                   ← price list / happy hour / promo
              │
              ▼
        Promotion resolution                 ← discounts / bundles / loyalty
              │
              ▼
        Tax resolution                       ← rate / group / fiscalisation
              │
              ▼
        Inventory availability validation    ← locked read
              │
              ▼
        Inventory reservation                ← time-boxed, single system
              │
              ▼
        Payment initiated
              │
              ▼
        Payment authorized                   ← tender-specific (cash/card/mpesa)
              │
              ▼
        Transaction commit                   ← atomic, idempotent
              │
        ┌─────┼─────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼
   Inventory     GL posting   Analytics    Audit
   movement    (per-sale)      event       event
              │
              ▼
        Domain events emitted                ← outbox, same tx
              │
              ▼
        Receipt generation                   ← from committed snapshot
              │
              ▼
        Customer history / loyalty accrual
              │
              ▼
        Transaction closed
```

## Ownership contract per stage

| Stage | Owner | Boundary invariant |
|---|---|---|
| Basket | POS UI | Ephemeral; not persisted server-side beyond `pos_held_transactions`. |
| Product resolution | Product domain (RPC) | POS reads from a resolver, does not embed catalog logic. |
| Pricing resolution | Pricing domain (RPC) | Client may *display* a price; server *authorises* it at commit. |
| Promotion resolution | Promotions domain (RPC) | Applied server-side at commit; client sends intent only. |
| Tax resolution | Tax domain (RPC) | Server re-derives from `tax_rates`/`tax_groups` at commit. |
| Availability | Inventory domain (RPC) | Pessimistic lock (`FOR UPDATE`) on affected `stock_quants` inside the commit. |
| Reservation | Inventory domain (single table) | One reservation system across POS, Sales, WMS. |
| Payment authorize | Payment domain | Tender-specific; captured before commit; commit records only what was captured. |
| Commit | POS transaction engine | Single RPC, atomic, idempotent, branch-isolated. |
| Inventory movement | Inventory domain (shared helper) | Composed via `_pos_post_movement`; never re-implemented per RPC. |
| GL posting | Finance domain (per-sale RPC) | Composed via `post_pos_sale_gl` inside the commit transaction. |
| Domain events | Outbox | Emitted in the same tx as the commit; consumers idempotent by `pos_transaction_id`. |
| Receipt | Presentation layer | Rendered from the persisted `snapshot`, never from live client state. |
| Loyalty / customer history | Customer / Loyalty domains | React to `sale.committed` outbox event; never write inside the commit RPC. |
| Close | POS transaction engine | Deterministic transition; not a batch financial process. |

## Where the current implementation sits

See `docs/audit/pos-transaction-engine.md` §4 for the stage-by-stage
gap table. Summary of gaps that ADR 0082 and batches T1–T7 close:

- Pricing / promotion / tax resolution → move to server, batch **T1**.
- Availability → pessimistic lock, batch **T4**.
- Reservation → single system, batch **T3**.
- Commit → mandatory idempotency, batch **T2**.
- Inventory movement → shared helper, batch **T6**.
- GL posting → per-sale, batch **T5**.
- Domain events → add `sale.committed` and `inventory.decremented`,
  batch **T7**.

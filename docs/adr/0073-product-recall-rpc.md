# ADR 0073 — Product Recall RPC (`recall_lot`)

**Status:** Accepted (Phase G+, 2026-07-17)
**Supersedes:** — **Superseded by:** —

## Context

ADR 0070 landed the read path for lot genealogy (per-warehouse on-hand,
per-lot movement timeline, downstream reference resolution). The parent
audit prompt calls out product recall as the enterprise litmus test:

> Which supplier supplied this batch? Which warehouse received it?
> Which customer bought it? … Can we perform a product recall?

Prior state: no way to convert the read path into an operational action.
The `product_recalls`, `product_recall_items` and `lot_quarantine`
tables existed as empty containers with no writer.

## Decision

Add a single, atomic `public.recall_lot` PL/pgSQL function:

- **Contract:** `recall_lot(business_id, product_id, lot_number, reason,
  severity, reference)` returning a JSON summary.
- **Security:** `SECURITY DEFINER`, `search_path = public`, gated by
  `user_can_access_business(auth.uid(), business_id)` — no RLS bypass
  is exposed beyond the caller's own business.
- **Grants:** `EXECUTE` to `authenticated`; explicitly `REVOKE`d from
  `anon`.
- **Behaviour, in one call:**
  1. Insert a `product_recalls` header (auto-generated
     `RCL-<timestamp>-<lotfrag>` reference when the caller omits one).
  2. Aggregate remaining on-hand per warehouse from `stock_movements`,
     partitioned by `(business_id, product_id, lot_number)` — inbound
     types add, everything else subtracts.
  3. For every warehouse with net > 0, insert `lot_quarantine`
     (status = `quarantined`, `recall_id` set) **and** a matching
     `product_recall_items` row.
  4. Enumerate downstream customers by joining `stock_movements` where
     `reference_type = 'invoice_item'` → `invoice_items` → `invoices`
     → `contacts`, returning a per-customer manifest with invoice
     detail.

The function is the single writer for recall state. UI, CLI, and future
edge functions all funnel through it.

## Consequences

- The Lot Genealogy page (`LotDetail`) exposes a "Recall this lot"
  action guarded by `manageProducts`. The UI never writes to
  `product_recalls`, `product_recall_items`, or `lot_quarantine`
  directly.
- Recall reads become the same as any other lot query — the quarantined
  quantity naturally drops out of the on-hand calculation because the
  aggregate is derived from movements, not from a static counter.
- A future `product.recall.opened` outbox event and SMS/email
  broadcast to enumerated customers slots in without changing the
  function signature.

## Out of scope

- Notifying customers automatically (email/SMS/portal). The manifest is
  returned; the notify step is a follow-up outbox consumer.
- Serial-level recall (recalling by `stock_serials.serial_number` in
  addition to lot). Serials are already linked to their parent lot via
  `stock_serials.lot_id`; recall-by-serial can layer on later.

## Guards

`src/test/architecture/recall-rpc.test.ts` asserts:

- The migration installs `public.recall_lot` with the six-argument
  signature.
- `EXECUTE` is granted to `authenticated` and revoked from `anon`.
- `LotDetail.tsx` calls `rpc("recall_lot", ...)` — the UI never writes
  the recall tables directly.

# Sales / POS / Invoice transaction pipeline — diagnostic + repair plan

## Context

Two failures reported after the Inventory replenishment/approvals work:

1. `POST /rest/v1/invoices` → **400 Bad Request** (invoice creation)
2. `POST /rest/v1/rpc/process_pos_transaction` → **404 Not Found** (POS commit)

Zero-trust checks already done in plan mode:

- `process_pos_transaction(uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,numeric,numeric,numeric,text,uuid,text,text,text,uuid,uuid,uuid,numeric,uuid,text)` **exists** in `public`. `authenticated` has EXECUTE. The FE named params (`src/hooks/pos/usePOSTransactionOffline.ts`) match the signature — no missing required args. A 404 with these facts is a **PostgREST schema-cache miss**, not a missing function. Do not recreate the RPC.
- `public.invoices` carries ~20 triggers (revenue projection, fiscal enqueue, SO/proforma/contact business-match, count-limit, GL integrity, POS-credit lineage, revenue projection, plus a **duplicate pair** `trg_notify_invoice_created` + `trigger_notify_invoice_created` both firing `notify_invoice_created`). Any BEFORE INSERT trigger raising will surface as PostgREST 400 on the invoice POST.
- Recent inventory migrations (Jul 12–14) touched `reset_module__inventory`, procurement recommendations, approval mirror trigger, `attach_recommendation_to_po`, `cancel_procurement_approval`. None of them redefine `process_pos_transaction`, `invoices` triggers, `stock_movements` trigger, or `pos_transactions` schema — but the reset migration replaced governance function bodies and may have invalidated PostgREST's cached plan for `process_pos_transaction`.

## Canonical ERP lifecycle (reference)

```text
Sales order → Invoice header → Invoice items → Inventory reservation
             → Delivery / shipment → Stock movement (COGS)
             → Invoice.status='confirmed' → GL journal (AR + Revenue + Tax + COGS)
             → Receivable → Payment allocation → Receipt
```
```text
POS cart → process_pos_transaction (single txn):
             validate stock → reserve/consume → pos_transactions insert
             → pos_transaction_items → pos_transaction_payments
             → stock_movements (sale) → cash/AR posting event
             → domain event (sale.committed) → fiscal enqueue → receipt
```
Both paths must share:
- one stock-movement writer (RLS + branch trigger already in place)
- one journal poster (`post_journal_entry_atomic`)
- one AR engine (single open-items engine per ADR 0033)

## Phase 1 — Reproduce and capture ground truth (no writes)

1. Trigger both failures from the running preview (POS commit + create invoice on `/sales/invoices/new`) and read the full response body via `code--read_network_requests` — PostgREST returns `code`, `message`, `hint`, and (for 404 RPC) the exact "Could not find the function … with parameters (…)" line. That message is the only reliable diagnostic; every fix below is contingent on it.
2. Run the same POS RPC with `supabase--read_query` wrapping a `SELECT` on `pg_proc` + a signature probe to confirm PostgREST is out of sync with the DB.
3. Inspect the invoice payload the FE actually posts (`useInvoices` / invoice create page) and cross-check every column against `public.invoices` schema + the BEFORE INSERT triggers listed above.

Nothing is patched in Phase 1 — this closes the actual root cause instead of guessing.

## Phase 2 — Targeted repairs (only what Phase 1 proves)

Branch A — **POS 404 is a schema-cache miss** (most likely):

- Issue `NOTIFY pgrst, 'reload schema';` from a small migration to force PostgREST to re-introspect. Add a defensive `GRANT EXECUTE … TO authenticated` (idempotent) to survive future reloads.

Branch B — **POS 404 is a signature drift** (only if Phase 1 shows a "parameters (…)" mismatch):

- Adapt the FE call in `usePOSTransactionOffline.ts` + `TransactionQueue.ts` to the live signature, or add a thin overload — but never recreate the function body. The canonical implementation lives in the last migration that defined it.

Branch C — **Invoice 400 is a trigger raising** (most likely — a BEFORE INSERT trigger validating branch/business/proforma/SO/contact, or the count-limit trigger):

- The Phase 1 error body identifies the exact trigger + constraint. Fix by (i) supplying the missing/valid column from the FE if the payload is wrong, or (ii) tightening the trigger's guard clause if the recent inventory reset invalidated a helper it depends on (e.g. `_is_teardown_for_org` still exists; `get_effective_invoice_limit` still exists).
- Drop the duplicate `trigger_notify_invoice_created` (keep `trg_notify_invoice_created`). Duplicate isn't the 400 cause but it double-emits notifications and is a latent bug.

Branch D — **Invoice 400 is RLS** (only if code is `42501`):

- Verify `invoices` INSERT policy still routes through `user_can_access_business` + branch check; recent inventory RLS rewrites did not touch `invoices`, but confirm.

## Phase 3 — Consolidation and guardrails (small, high-value)

- Add an architecture test that asserts every RPC referenced by `src/hooks/pos/**` and `src/hooks/**invoice**` resolves to exactly one function in `pg_proc` with matching param names. Catches schema drift before it reaches production.
- Add a lightweight pgTAP case that `process_pos_transaction` exists with the current 21-arg signature and has `EXECUTE` for `authenticated`.
- Document in `docs/adr/` that Sales-invoice and POS-sale share one journal poster and one stock-movement writer, and that only migrations may recreate `process_pos_transaction` (no client-side fallback path).

## Explicitly NOT in scope

- Recreating `process_pos_transaction` from scratch. It exists.
- Rewriting the invoice trigger stack. The 400 is one raising trigger; fix that one.
- Any change to `stock_movements` / `warehouse_stock` / branch RLS (already audited).
- Any UI change beyond aligning the two RPC call sites if Branch B is proven.

## Files likely touched (build-mode)

- `supabase/migrations/<new>.sql` — `NOTIFY pgrst`, defensive GRANT, drop duplicate invoice trigger, any trigger-guard tightening Phase 1 identifies.
- `src/hooks/pos/usePOSTransactionOffline.ts` + `src/services/offline/TransactionQueue.ts` — only under Branch B.
- `src/test/architecture/rpc-signature-drift.test.ts` (new) — Phase 3 guard.
- `supabase/tests/pos-transaction-rpc.sql` (new pgTAP case) — Phase 3 guard.
- `docs/adr/00XX-sales-pos-shared-pipeline.md` (new) — Phase 3 documentation.

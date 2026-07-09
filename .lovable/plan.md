# Physical Count → Recount → GL Posting — Lifecycle Investigation

I traced the full lifecycle before touching any code. The 400 is a symptom of two overlapping architectural drifts, not a syntax slip.

---

## 1. Lifecycle as it exists today

```text
create (draft)
  └─ physical_count_open / seed lines from warehouse_stock
freeze (frozen)
  └─ writes system_qty_at_freeze on each line
  └─ records last_movement_id per product in physical_count_freeze_movements
count (counting)
  └─ operator writes counted_qty (line.status: pending → counted / variance)
submit (submitted)
  └─ tolerance rules flip lines to status='recount_required'
approve (approved)
  └─ SoD check: approver != creator/frozen_by/submitted_by
      request_recount  ── loops back to counting; adds a recount_qty on flagged lines
                          (physical_count_request_recount, audit event only)
post (posted)  ← FAILURE HERE
  ├─ recompute freeze_reconciliation_qty from movements since watermark
  ├─ INSERT stock_adjustment (status='draft')
  ├─ INSERT stock_adjustment_items + stock_movements (movement_type='adjustment')
  ├─ UPDATE physical_count_lines SET variance_qty = ..., variance_value = ...   ← 400
  ├─ UPDATE stock_adjustments SET status='approved' (raw UPDATE, bypasses RPC)
  ├─ INSERT journal_entries + journal_entry_lines (bypasses approve_stock_adjustment_atomic)
  └─ state='posted', outbox event
```

---

## 2. Root cause of the 400

`physical_count_lines.variance_qty` is defined once, in the table migration:

```sql
variance_qty numeric GENERATED ALWAYS AS
  (COALESCE(recount_qty, counted_qty, 0)
   - (system_qty_at_freeze + freeze_reconciliation_qty)) STORED
```

`physical_count_post` (latest migration, lines 470–474) then does:

```sql
UPDATE public.physical_count_lines
   SET status='approved',
       variance_qty   = v_final_variance,   -- ← illegal, column is GENERATED
       variance_value = v_final_variance * COALESCE(v_line.unit_cost_snapshot,0)
 WHERE id = v_line.id;
```

Postgres raises `Column "variance_qty" can only be updated to DEFAULT`. So the direct trigger of the toast is a **dual-write into a computed column**.

But `v_final_variance` is *also wrong* on its own:

```sql
v_final_variance := v_line.counted_qty              -- ignores recount_qty!
                  - (v_line.system_qty_at_freeze + v_since_movements_qty);
```

The generated column uses `COALESCE(recount_qty, counted_qty, 0)`; the RPC uses `counted_qty`. **After a recount, the RPC silently discards the recounted quantity and posts against the pre-recount count.** The "post the initial count" and "post the recount" paths therefore fork at the last mile, and the recount path only *appears* to converge because the generated column and the RPC compute different numbers.

That's why the error surfaces most obviously on recounted counts: the RPC's `v_final_variance` disagrees with the stored `variance_qty`, and the misguided attempt to overwrite the generated column collides with Postgres.

---

## 3. Architectural violations discovered

| # | Violation | Evidence |
|---|-----------|----------|
| A | **Dual source of truth for variance.** `variance_qty` is a stored generated column *and* the posting RPC recomputes and tries to overwrite it. Enterprise systems compute variance once (SAP MI, Oracle CST). | migrations 20260708001751 line 81 vs 20260709230633 line 472 |
| B | **Recount is not honored at post time.** RPC uses `counted_qty`, ignoring `recount_qty`. The generated column already encodes the correct precedence. | 20260709230633 line 431 |
| C | **ADR 0016 bypassed for physical-count adjustments.** RPC inserts `stock_adjustments` in `draft`, then flips to `approved` with a raw `UPDATE`, and posts a JE inline — bypassing `approve_stock_adjustment_atomic`, its cost-resolution fallback, idempotency guard, and immutability trigger. ADR 0016 explicitly forbids this. | 20260709230633 lines 394–523; docs/adr/0016 §"Consequences" |
| D | **Inconsistent field genesis on the same row.** `variance_qty` is generated; `variance_value` is manual. Either both should be derived (`variance_qty * unit_cost_snapshot`) or both stored — the mixed model invites exactly this kind of drift. | 20260708001751 lines 81, 84 |
| E | **Posting mutates snapshot fields.** RPC rewrites `freeze_reconciliation_qty` at post time. That column is meant to be the reconciled delta between freeze and post — legitimate to compute — but writing it back into the line mixes "immutable freeze snapshot" with "post-time reconciliation". It should live on a separate `physical_count_post_reconciliations` row (or be recomputed on demand), never mutate the counting sheet. | 20260709230633 lines 427–429 |
| F | **No idempotency on `physical_count_post`.** No `client_request_id`, no advisory lock beyond the `FOR UPDATE` on the header. A retried POST after a network hiccup would produce a second adjustment (the state-check saves it *only* if the first attempt committed). | 20260709230633 lines 273–291 |
| G | **Direct JE insert leaves `stock_adjustments.journal_entry_id`/`gl_posted` unlinked**, so the adjustment appears in `list_adjustments_missing_journals` even though a JE exists. Reconciliation card will mis-flag every physical-count adjustment. | 20260709230633 lines 488–523; docs/audit/2026-05-21 |

---

## 4. Enterprise reference (what SAP / Oracle / Odoo do)

- One document per count. Recounts amend line quantities in place (audit event captures previous value), they do **not** create a second adjustment.
- One posting per approved count. Adjustment quantity = `final_counted − book_qty_at_post`. Variance is *derived*, never stored twice.
- Posting delegates to the standard inventory-adjustment posting service — same cost resolution, same JE shape, same immutability rules — so audit and reversal work identically for count-originated vs manual adjustments.
- Reversal is done via a contra adjustment (ADR 0016's `reverse_stock_adjustment`), not by editing the count.

Our lifecycle almost matches this model; the deviations are (A)–(G) above.

---

## 5. Recommended fix (implementation, not band-aid)

### 5.1 `physical_count_post` — surgical

1. **Stop writing `variance_qty`.** It's generated. Removing the assignment fixes the 400.
2. **Read variance from the generated column** after the freeze reconciliation update — do not recompute in the RPC. Replace `v_final_variance := counted_qty - …` with a re-`SELECT variance_qty INTO v_final_variance` after the reconciliation UPDATE. This restores honoring `recount_qty`.
3. **Derive `variance_value`** in the same reconciliation update (`variance_qty * COALESCE(unit_cost_snapshot,0)`), or make it a generated column too. Recommendation: make it generated for symmetry (fixes violation D).
4. **Do not mutate `freeze_reconciliation_qty` on the counting sheet.** Move the reconciled-since-freeze quantity to a new one-row-per-line table `physical_count_post_reconciliations` (count_id, line_id, reconciled_qty, movement_cutoff, posted_at). The counting sheet stays immutable after approval.

### 5.2 Delegate GL posting to `approve_stock_adjustment_atomic`

Instead of hand-rolling the JE inside `physical_count_post`:

1. Insert `stock_adjustments` in `draft` **with `client_request_id = 'pc:' || count_id`** for idempotency.
2. Insert `stock_adjustment_items` with resolved cost.
3. Call `approve_stock_adjustment_atomic(adj_id, ...)` — it will move stock, post the JE via `post_journal_entry_atomic`, mark `gl_posted`, and honor ADR 0016 invariants (cost fallback, immutability trigger, reversal support).
4. Store the returned `adjustment_id` and `journal_entry_id` on `physical_counts`.

This fixes violations C, F, G in one move and removes ~120 lines of duplicated posting SQL.

### 5.3 Recount path unification

- `physical_count_request_recount` remains the only way to open a recount round; it clears `counted_qty`/`recount_qty` only for flagged lines and emits `recount_requested`.
- Recount UI writes `recount_qty` (not `counted_qty`). Generated column already handles precedence.
- Approve → post reads `variance_qty` — one converged path for initial-only and recounted counts.

### 5.4 Reversal

Physical-count adjustments become reversible via the existing `reverse_stock_adjustment(adj_id, reason)` because they're now standard `stock_adjustments` posted through the atomic RPC. The count's `state` gets a new value `reversed` linked to the contra adjustment via `posted_adjustment_ids[2]`.

### 5.5 UI changes (minimal, presentation only)

- `PhysicalCountDetail.tsx` already reads `variance_qty` and `variance_value` from the row — no change needed.
- Add a small "GL impact" strip that shows `journal_entry.entry_number`, surplus, shrinkage, and a "Reverse posting" action wired to `reverse_stock_adjustment`. Wire `posted_journal_entry_id` for a deep link.
- No changes to freeze/count/submit/approve/request_recount flows.

### 5.6 Test coverage to add

- pgTAP: posting an approved count where a line has `recount_qty` produces an adjustment with `quantity_adjustment = recount_qty - (system + reconciliation)` (currently would use `counted_qty` — asserts regression is impossible).
- pgTAP: re-invoking `physical_count_post` after a simulated network retry produces one adjustment and one JE (idempotency).
- pgTAP: `variance_qty` cannot be written (guarded by generated-column semantics; the test asserts the RPC no longer attempts it by grepping the migration).
- Architecture test in `src/__tests__/architecture.physical-count-lifecycle.test.ts`: latest post migration must call `approve_stock_adjustment_atomic` and must NOT contain `INSERT INTO public.journal_entries` or `variance_qty =`.

---

## 6. Migration order

1. **Migration 1 — schema:** create `physical_count_post_reconciliations`; make `physical_count_lines.variance_value` a generated column (backfill first). GRANTs + RLS following the standard pattern.
2. **Migration 2 — RPC rewrite:** replace `physical_count_post` with the delegating version (calls `approve_stock_adjustment_atomic`, no direct JE, no writes to generated columns, no mutation of freeze snapshot). Keep the same signature and return shape.
3. **Migration 3 — backfill/repair:** any count already in `posted` state stays as-is; add a one-shot linker that populates `stock_adjustments.journal_entry_id` for physical-count adjustments so the reconciliation card stops mis-flagging them.
4. **Frontend patch:** add the GL-impact strip and reverse action in `PhysicalCountDetail.tsx`.
5. **Tests:** add pgTAP + architecture tests above.

---

## 7. What I explicitly did NOT do

- Did not just delete the `variance_qty = …` line. That would hide the recount fork (violation B) and leave the ADR 0016 bypass (C) and the missing-JE linkage (G) in place.
- Did not change the generated column expression. It correctly encodes the enterprise rule `variance = final_counted − book_at_post`.
- Did not touch the freeze / count / submit / approve / request_recount RPCs — they are correct.

Approve this plan and I'll ship it in the order above.

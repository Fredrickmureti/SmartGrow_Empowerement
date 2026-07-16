## Phase 0 — Verification of prior work (done)

Cross-checked `.lovable/plan.md` claims against the codebase:

| Claim | Verified |
|---|---|
| ADRs 0064–0067 present | ✅ |
| 7 migrations `20260716210212` → `215647` present | ✅ |
| Downstream lot/serial columns + recall view + posting-guard | ✅ |
| Serialised inventory schema (`stock_serials`) + movement guard | ✅ |
| Architecture guards `outbound-lot-stamping.test.ts` + `serial-tracking.test.ts` | ✅ 8/8 tests pass |
| `useStockQuants` hook present | ✅ |
| `warehouse_stock` still authoritative; Phase 5 gated on 14 clean drift-check days | ✅ correct posture |

**Verdict:** Phases 1–4 (locations/quants/transit/quarantine), Phase A.1–A.2 (downstream lot stamping + RPC propagation), and Phase B (serials) are genuinely delivered and contract-tested. No superficial patches detected. The only remaining ⚠ from the audit that is a *small, high-leverage* refactor is Phase C — split-transfer adoption.

## What I execute next — Phase C · split-transfer adoption

**Why now:** transit location + `v_stock_on_hand` transit filter already exist (Phase 4). This is the last piece that makes in-transit stock a real ledger state instead of a naming convention, and it unblocks Phase D (ASN) cleanly.

### Steps

1. **Read existing transfer surface** — `src/hooks/useWarehouses.ts` (transfer list/create paths) and the latest `create_stock_transfer` / `complete_stock_transfer` RPC definitions across the 4 migrations that touch them. Understand current single-movement `transfer` emission before changing anything.

2. **ADR 0068 — Split stock transfers** (one page): defines the two-movement contract (`transfer_out` source→transit, `transfer_in` transit→destination), the atomic vs in-transit modes, and how `v_warehouse_stock_effective` continues to net out.

3. **Migration** (`supabase/migrations/2026071622*_split_stock_transfer.sql`):
   - Rewrite `complete_stock_transfer` (or introduce `complete_stock_transfer_v2` + wrapper) to emit both movements in one transaction via `get_business_transit_location(business_id)`. Instant transfers fire both; in-transit transfers fire `transfer_out` on submit and `transfer_in` on receipt.
   - Backfill: none required — historic single-movement transfers stay as-is; the view already tolerates them.
   - GRANT + RLS unchanged (RPC is `SECURITY DEFINER`, callers already gated).

4. **Architecture guard** `src/test/architecture/split-transfer.test.ts` — pins the migration SQL to the two-movement contract (SQL string inspection, same pattern as the existing guards).

5. **Verify:** run the new guard + the two existing inventory guards; confirm `v_warehouse_stock_effective` still excludes transit rows.

6. **Update `.lovable/plan.md`** with a Phase C completion entry and hand off Next 2 (A.3 UI pickers) and Next 3 (Phase D ASN) to the next agent.

### Explicitly out of scope this turn

- Phase A.3 UI plumbing (lot/serial pickers on invoice/CN/return forms).
- Phase D ASN / inbound shipments.
- Phase E–H (variants, import split, lot genealogy, GS1).
- Retiring `warehouse_stock` — still drift-gated.

## Technical notes

- No changes to `warehouse_stock` triggers or to `src/integrations/supabase/types.ts` (regenerated post-migration).
- `movement_type` is `text`; `transfer_out`/`transfer_in` add without an enum migration.
- RPC stays idempotent via existing transfer status guards; no new idempotency key needed.
- Follows CREATE → GRANT → RLS → POLICY order for any new object; migration is RPC-only so no new tables expected.

## First deliverable if approved

1. ADR 0068.
2. Migration rewriting `complete_stock_transfer` to emit `transfer_out` + `transfer_in`.
3. `src/test/architecture/split-transfer.test.ts`.
4. Plan-log update.

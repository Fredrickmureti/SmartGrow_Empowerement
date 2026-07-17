# Inventory Foundation Audit — Resume Plan

## Phase 1 — Verification of prior work (findings)

I audited `.lovable/plan.md` against the actual repo:

| Claim in handoff | Verified state |
|---|---|
| Localization edge functions consolidated into `localization-pack` router | ✅ router exists at `supabase/functions/localization-pack/` |
| Callers migrated to `invokeLocalizationPack` | ✅ helper present at `src/integrations/supabase/invokeLocalizationPack.ts` |
| 11 legacy edge functions deleted from Supabase (dashboard) | Not verifiable from repo — trust user action |
| Legacy **source folders** removed from `supabase/functions/` | ❌ **All 11 folders still on disk** (apply-default-mappings, apply-localization-pack-upgrade, install-localization-pack, lint-localization-pack, preview-default-mappings, process-localization-outbox, promote-pack-version, propose-localization-upgrades, publish-localization-pack-version, rollback-localization-pack-upgrade, validate-localization-payload) |
| `stock-quant-drift` deployed | Folder present on disk |
| Inventory Foundation Audit executed | ❌ **Not started.** `.lovable/inventory-foundation-audit.md` does not exist. The actual mandate is untouched. |

**Conclusion:** only the infra unblock happened. The audit itself — the user's real mandate — is fully pending. Resume from Step A.

## Phase 2 — Plan (execution order)

### Step A — Repo hygiene (single turn)
1. `rm -rf` the 11 legacy edge-function folders listed above.
2. `rg` outside `invokeLocalizationPack.ts` for any lingering references to those names; patch or flag.
3. Grep `supabase/migrations/` for `cron.schedule.*process-localization-outbox`. If found → migration repointing to `localization-pack` with `{"op":"process-outbox"}`. If absent → flag to user that a dashboard cron may need repointing.

### Step B — Inventory Foundation Audit (the real work)
Reason in **business events**, not tables. Investigate first, verdict second. Produce a **single concise document** at `.lovable/inventory-foundation-audit.md` — terse, evidence-driven, no filler prose (respecting "not interested in long markup files").

Investigation order:
1. **Schema sweep** via `supabase--read_query` on `information_schema` for: `product*`, `stock*`, `quant*`, `warehouse*`, `uom*`, `barcode*`/`product_identifiers`, `lot*`, `serial*`, `goods_receipt*`, `purchase_order*`, `movement*`, `transfer*`, `adjustment*`, `cycle_count*`. Capture FKs + key indexes.
2. **Movement engine** — locate writers of `stock_movements` (`src/lib/inventory/stockLedger.ts` + triggers `_maintain_warehouse_stock_lots`, `_maintain_cost_layers`). Check: single writer? idempotency? reversal? cost method (ADR-0002 says AVCO)?
3. **Traceability chain** — attempt PO → GRN → lot → warehouse → sale → return reconstruction against live data with `supabase--read_query`. Identify break points.
4. **UoM** — verify base-unit-of-truth contract (`mem/features/multi-unit-inventory.md`, ADR 0023/0035); check purchase/stock/sales UoM separation and immutability triggers.
5. **Barcodes** — `product_identifiers` 1:N, per-packaging barcodes, GTIN types, primary flag.
6. **Batch/Lot & Serial** — `stock_lots`, `warehouse_stock_lots`, FEFO RPCs (ADR 0025); check serials table (`stock_serials`) coverage and whether outbound flows honor serial capture.
7. **Warehouse hierarchy** — flat vs Site→Zone→Aisle→Bin (`warehouses`, `stock_locations`).
8. **Goods Receipt** — `goods_receipts`, `goods_receipt_items`, `goods_receipt_discrepancies`, `inbound_shipments`, `backorders`; 3-way match, partial/over receipt, landed cost.
9. **Product Import** — split configs under `src/lib/importConfigs/product/` (ADR 0074); staging vs direct write; error surfacing.
10. **Integration readiness** — `business_event_outbox`, `domainEventBus`, realtime; whether downstream modules (POS, Finance, Sales) consume events or read tables directly.

For each of the 11 pillars, one section with:
- **Evidence** (file / table / migration IDs — links, not paragraphs)
- **Verdict**: ✅ Ready / ⚠️ Gap / ❌ Missing
- **Enterprise benchmark**: one line comparing SAP / NetSuite / D365 / Odoo posture
- **Remediation** (only if Gap/Missing): concrete, dependency-ordered

Close with a one-page **executive verdict**: as-is / fix-forward / re-foundation.

### Step C — Stop and present
Post the verdict summary in chat. **Do not** start remediation migrations without explicit user approval. The audit is a decision document; execution comes after direction.

## Non-goals (explicit)
- No UI patching.
- No re-opening localization consolidation.
- No touching hosting/security scan flow.
- No writing schema migrations until the user picks a remediation path from the audit.

## Deliverable
`.lovable/inventory-foundation-audit.md` — terse, pillar-by-pillar verdict with evidence + prioritized remediation, followed by an executive recommendation.

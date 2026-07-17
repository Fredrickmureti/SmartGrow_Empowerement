# HANDOFF — Inventory Foundation Audit (resume here)

## TL;DR for the next agent
The user's real mandate is an **Enterprise Inventory Foundation Audit** (see "Original mandate" below). Everything up to now has been unblocking infra so we can run it. Slot ceiling is now cleared, `localization-pack` router and `stock-quant-drift` are deployed. **Start Step A (repo cleanup, ~5 min) then jump straight into the audit at Step B.** Do NOT re-open the localization consolidation — it's done.

---

## Original mandate (verbatim intent, do not lose sight of this)
Audit whether the Inventory module is architecturally capable of being the foundation for an enterprise-grade POS + WMS + Purchasing + Finance + Manufacturing platform. Reason in **business events**, not tables. Benchmark against SAP, Oracle NetSuite, Microsoft Dynamics 365.

Scope (11 pillars):
1. Product Master
2. Barcode Architecture
3. Multi-Unit Inventory (UoM)
4. Batch / Lot Architecture
5. Serial Number Architecture
6. Goods Receipt Architecture
7. Product Import Architecture
8. Inventory Traceability
9. Inventory Movement Engine
10. Warehouse Architecture
11. Integration Readiness (POS, WMS, Purchasing, Finance, Manufacturing hooks)

Deliverable: a written architectural verdict per pillar (Ready / Gap / Missing) with concrete evidence from the codebase + schema, plus a prioritized remediation list. NOT a UI patch. NOT per-screen bugfixing.

---

## What has been implemented (done — do not redo)

### Infra unblock (completed this session)
- ✅ Consolidated 11 localization edge functions into a single `supabase/functions/localization-pack/` router (op-dispatch).
- ✅ All in-app callers migrated to `invokeLocalizationPack` helper.
- ✅ 11 legacy edge functions **deleted from Supabase** by the user via the dashboard.
- ✅ `localization-pack` deployed.
- ✅ `stock-quant-drift` deployed (was the originally-blocked inventory function).
- ✅ Slot ceiling cleared.

### Prior audit artifacts (read before starting)
- `.lovable/audit-2026-04.md` — earlier audit notes (check what's already covered).
- `.lovable/accounting-audit-report.md` — reference for the report format/tone expected.
- `.lovable/localization-pack-consolidation-plan.md` — closed, kept for history.

---

## What remains

### Step A — Repo hygiene (do first, one turn)
Legacy edge function **source folders** are still on disk under `supabase/functions/`. If left, the next deploy cycle re-creates them and re-consumes slots. Delete these directories with `rm -rf`:

- `apply-default-mappings`
- `apply-localization-pack-upgrade`
- `install-localization-pack`
- `lint-localization-pack`
- `preview-default-mappings`        ← verify presence, may already be gone
- `process-localization-outbox`     ← verify presence
- `promote-pack-version`            ← verify presence
- `propose-localization-upgrades`   ← verify presence
- `publish-localization-pack-version` ← verify presence
- `rollback-localization-pack-upgrade`
- `validate-localization-payload`   ← verify presence

Then `rg` for any leftover string reference to those names outside `src/integrations/localization/invokeLocalizationPack.ts` (that file intentionally keeps them as op-name literals). Also grep repo migrations for `cron.schedule.*process-localization-outbox` — if found, patch to call `localization-pack` with `{"op":"process-outbox"}`. If not in repo, flag to user that a dashboard cron may need repointing.

### Step B — Run the Inventory Foundation Audit (the actual job)

Do NOT start with UI. Start with **schema + services + engine**. Suggested path:

1. **Schema sweep** — `supabase--read_query` on `information_schema` to enumerate every table matching: `product*`, `item*`, `stock*`, `quant*`, `warehouse*`, `location*`, `uom*`, `unit*`, `barcode*`, `batch*`, `lot*`, `serial*`, `goods_receipt*`, `grn*`, `po*`, `movement*`, `transfer*`, `adjustment*`, `cycle_count*`. Map columns, FKs, indexes.
2. **Movement engine** — locate the module that writes stock movements (likely `supabase/functions/_shared/inventory/*` or `src/services/inventory/*`). Verify: single source of truth? double-entry style (debit location / credit location)? idempotency keys? reversal semantics? cost layer (FIFO/AVG/STD)?
3. **Traceability chain** — can we reconstruct: PO → GRN → Batch → Location → Transfer → Sale → Return for one unit? What breaks the chain?
4. **UoM** — is there a conversion table with base UoM per product, or are conversions hardcoded per-line? Purchase-UoM vs Stock-UoM vs Sales-UoM separation?
5. **Barcodes** — 1:N table? GTIN vs internal? per-UoM barcodes (case/pack/each)?
6. **Batch/Lot & Serial** — separate tables or overloaded? expiry, mfg date, supplier lot, cost per batch? Serials tracked as inventory rows or as attributes?
7. **Warehouse** — hierarchy (Site → Zone → Aisle → Bin)? Or flat "location"? Multi-warehouse quants?
8. **Goods Receipt** — 3-way match hook (PO ↔ GRN ↔ Invoice)? Over/under receipt? Partial receipts? Landed cost capture?
9. **Product Import** — CSV/XLSX importer: what does it validate? Does it write to a staging table with row-level errors, or straight into `products`? Does it support UoM/barcode/opening-stock in one file?
10. **Integration readiness** — do we expose stable events (e.g., `stock.movement.created`, `product.master.updated`) that POS/WMS/Finance/Manufacturing can subscribe to? Or are downstream modules coupled directly to inventory tables?

For each pillar, write a section in a NEW file `.lovable/inventory-foundation-audit.md` with:
- **Evidence** (file paths, table names, function names, migration IDs)
- **Verdict**: Ready ✅ / Gap ⚠️ / Missing ❌
- **Enterprise benchmark**: how SAP / NetSuite / D365 handles it
- **Remediation** (only if Gap/Missing): concrete schema + service changes, ordered by dependency

Close with an executive verdict: can this foundation support the platform vision as-is, with fixes, or is a re-foundation required?

### Step C — Present verdict to user, wait for direction
Do NOT start writing migrations from the remediation list without explicit user go-ahead. The audit is a decision document.

---

## Known pitfalls / do not repeat
- **Do not** try to publish, delete more edge functions, or touch security scan flow — the user was very clear that Vercel handles hosting and this is out of scope.
- **Do not** patch individual inventory screens/UI as "audit findings" — that's the trap the user explicitly rejected.
- **Do not** re-propose localization consolidation — it is closed.
- The runtime error `Cannot find module '#tanstack-start-entry'` is a preview-only sandbox artifact, not a shipped bug; ignore unless the user raises it.

## Useful tool cheatsheet
- Schema introspection: `supabase--read_query` with `information_schema.columns` / `pg_indexes` / `pg_constraint`.
- Bulk code search: `rg -n --type ts 'stock_move|quant|goods_receipt'`.
- Migration list: `ls supabase/migrations/ | tail -50` to see recent inventory-touching changes.

## Files/paths worth opening first
- `supabase/functions/stock-quant-drift/` (just deployed — reveals current movement model)
- `supabase/functions/_shared/inventory/` (if exists)
- `src/services/inventory/`, `src/features/inventory/`
- Latest migrations touching `stock_`, `product_`, `warehouse_`.

— End of handoff —

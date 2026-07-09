# Physical Count post → 404 — Investigation & Fix

## Business-event trace

```
create → freeze → record lines → submit → approve → post
         (stock)                          (JE + inv adjustment posted)
                                                    │
                                                    ▼
                                        land on Count Detail (read-only anchor)
                                        ├─ drill-through: Journal Entry
                                        ├─ drill-through: Stock Adjustment
                                        └─ drill-through: Stock Movements
```

The count document is the ledger-anchor for the whole event (per ADR 0016 and the physical-count lifecycle guard test). Adjustment + JE are produced by `physical_count_post` and linked back to the count via `source_type='inventory_adjustment' + source_subtype='physical_count'`. That matches how SAP (MI07), Odoo (`stock.inventory`), D365 (counting journals), Oracle, and NetSuite behave: **the count stays the source-of-record, becomes read-only after posting, and exposes JE / movement drill-throughs from its detail page.** So the *destination* — the count-detail page — is architecturally correct.

## Actual root cause of the 404

The Inventory app is mounted in `src/App.tsx` at:

```
path="/inventory-app/*"    → <InventoryApp />  (defines physical-counts/:id)
```

But the post-submit navigation in `src/pages/inventory/PhysicalCount.tsx:226` sends the browser to:

```
window.location.assign(`/inventory/physical-counts/${countId}`)
                        ^^^^^^^^^^ wrong prefix — no route matches → 404
```

The UUID is correct (the freshly created `physical_counts.id`). The destination is correct. Only the URL **prefix is stale** — it uses the legacy `/inventory/...` namespace instead of the canonical `/inventory-app/...` used everywhere else (Products, Warehouses, Adjustments, Transfers, Stock all live under `/inventory-app/`).

Grep confirms this is a small, localized drift — 5 stale links total, all in Physical Count pages plus one POS banner:

| File | Line | Broken link |
|---|---|---|
| `src/pages/inventory/PhysicalCount.tsx` | 226 | `` `/inventory/physical-counts/${countId}` `` |
| `src/pages/inventory/PhysicalCountWorkspace.tsx` | 181 | `` `/inventory/physical-counts/${c.id}` `` |
| `src/pages/inventory/PhysicalCountWorkspace.tsx` | 241 | `/inventory/count` |
| `src/pages/inventory/PhysicalCountDetail.tsx` | 316 | `/inventory/physical-counts` |
| `src/components/pos/POSReadinessBanner.tsx` | 253, 262 | `/inventory/warehouses` |

## Fix (smallest change that restores the correct business-event flow)

Rewrite the 5 stale links to the canonical `/inventory-app/...` prefix. No new routes, no new pages, no navigation rethink — the count-detail destination is already the correct enterprise landing surface.

1. `PhysicalCount.tsx` L226 → `/inventory-app/physical-counts/${countId}`
2. `PhysicalCountWorkspace.tsx` L181 → `/inventory-app/physical-counts/${c.id}`
3. `PhysicalCountWorkspace.tsx` L241 → `/inventory-app/count`
4. `PhysicalCountDetail.tsx` L316 → `/inventory-app/physical-counts`
5. `POSReadinessBanner.tsx` L253, L262 → `/inventory-app/warehouses`

Also swap the `window.location.assign` in `PhysicalCount.tsx` for `useNavigate()` so it stays inside the SPA (no full reload, preserves the query-invalidation on the workspace key that runs one line above).

## Guard test (prevent regression)

Add an architecture test `src/test/architecture/inventory-canonical-prefix.test.ts` that fails on any occurrence of `/inventory/` (not `/inventory-app/`) inside `src/pages/inventory/**`, `src/apps/inventory/**`, and `src/components/**`. This locks the URL contract so the two prefixes cannot drift again.

## Out of scope

- No changes to the Physical Count lifecycle RPCs, GL posting, adjustment linkage, or invariants from ADR 0016.
- No re-navigation to the JE or adjustment — those remain drill-throughs from the count detail, matching SAP/Odoo/D365 convention.
- Unrelated pre-existing build errors are ignored per the standing instruction.

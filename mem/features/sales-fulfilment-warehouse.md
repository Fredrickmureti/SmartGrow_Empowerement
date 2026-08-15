---
name: sales-fulfilment-warehouse
description: Phase 6b invariants — the warehouse a Sales document commits stock from is a recorded, server-resolved decision, and availability must be read from that same warehouse.
type: feature
---
- `sales_orders`, `invoices`, `delivery_notes` each carry `warehouse_id`. It is a RECORDED decision at creation, never inferred later at goods issue.
- `public.resolve_sales_warehouse(org, business, branch, requested)` is the ONE authority: it validates the requested warehouse against business/branch and falls back to the branch default. `create_invoice_atomic`, `create_sales_order_atomic`, `create_delivery_note_atomic`, `confirm_sales_order_atomic`, `complete_delivery_atomic` and `list_products_with_branch_stock` all go through it.
- `_invoices_governed_write` locks `invoices.warehouse_id` once the invoice leaves draft.
- Availability must be read from the SAME warehouse the document will reserve against: `useBranchScopedProducts({ warehouseId })` → `list_products_with_branch_stock(p_warehouse_id)`. Reading the branch aggregate while reserving from one warehouse is the defect this phase closed.
- Client seam: `useSalesWarehouse()` + `<SalesWarehouseField />` (`src/features/sales/warehouse`). The field hides itself when the branch has ≤1 warehouse; null selection means "server picks the branch default".
- Guard: `src/test/architecture/sales-warehouse-selection.test.ts`.

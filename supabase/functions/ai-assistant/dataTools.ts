/**
 * Read-only, tenant-scoped data tools for the AI assistant.
 *
 * Why this exists: the assistant used to see one fixed snapshot (50 invoices,
 * 30 days of expenses, ...) and had to bluff about anything outside it. Now it
 * can ask for what it needs.
 *
 * SAFETY CONTRACT — the assistant function runs on the SERVICE ROLE key, so
 * RLS does NOT protect these reads. Every guarantee is enforced here:
 *   1. Table allowlist. Nothing outside `DATA_TABLES` is reachable.
 *   2. Column allowlist per table. No `select *`, so no secrets, hashes or
 *      vault ids can ever be projected.
 *   3. Mandatory organization scoping on every query, plus business/branch
 *      scoping when the caller is inside one.
 *   4. Filters are structured (column/op/value) — never raw SQL, never a
 *      PostgREST filter string the model composes itself.
 *   5. Reads only. There is no insert/update/delete path in this module.
 *   6. Hard row cap.
 */

export interface ToolScope {
  organizationId: string;
  businessId?: string | null;
  branchId?: string | null;
  /** Branch ids the caller may see; empty means "all" (admin). */
  accessibleBranchIds?: string[];
  isAdmin: boolean;
}

interface TableSpec {
  /** Columns the model may project and filter on. */
  columns: string[];
  /** Column holding the organization id (always enforced). */
  orgColumn: string;
  /** Column holding the business id, when the table is business-scoped. */
  businessColumn?: string;
  /** Column holding the branch id, for non-admin narrowing. */
  branchColumn?: string;
  /** Human description shown to the model by describe_schema. */
  description: string;
}

export const DATA_TABLES: Record<string, TableSpec> = {
  invoices: {
    columns: ["id", "invoice_number", "status", "subtotal", "tax_amount", "total", "amount_paid", "currency", "issue_date", "due_date", "contact_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Customer invoices (AR). `total`/`amount_paid` are in `currency`.",
  },
  bills: {
    columns: ["id", "bill_number", "status", "subtotal", "tax_amount", "total", "amount_paid", "currency", "bill_date", "due_date", "contact_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Supplier bills (AP).",
  },
  expenses: {
    columns: ["id", "description", "amount", "currency", "expense_date", "status", "category_id", "vendor_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Recorded expenses.",
  },
  payments: {
    columns: ["id", "amount", "currency", "payment_date", "payment_method", "contact_id", "invoice_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Customer payments received.",
  },
  bank_accounts: {
    columns: ["id", "name", "bank_name", "account_number_masked", "currency", "current_balance", "is_primary", "is_active", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Bank accounts. `current_balance` is in the account's own `currency`, not necessarily the base currency.",
  },
  bank_transactions: {
    columns: ["id", "bank_account_id", "transaction_date", "description", "amount", "currency", "status", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Bank statement lines.",
  },
  contacts: {
    columns: ["id", "name", "company", "email", "phone", "type", "currency", "is_active", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Customers, suppliers and other parties.",
  },
  products: {
    // Physical columns. There is no `selling_price`/`quantity_on_hand`/`currency`
    // on this table — asking for them made every product read fail.
    columns: [
      "id", "name", "sku", "type", "unit_price", "cost_price", "tax_rate",
      "stock_quantity", "reorder_level", "reorder_quantity", "track_inventory",
      "is_lot_tracked", "is_expiry_tracked", "is_serial_tracked", "expiry_alert_days",
      "requires_qc", "status", "category_id", "base_uom_id", "sales_uom_id",
      "purchase_uom_id", "is_active", "business_id", "created_at", "updated_at",
    ],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description:
      "Product catalogue. `stock_quantity` is the org-wide on-hand in the product's BASE unit of measure; per-warehouse on-hand lives in `warehouse_stock` and per-location in `stock_quants`. `cost_price` is the unit cost used for valuation. Prices are in the business base currency.",
  },
  product_categories: {
    columns: ["id", "name", "description", "parent_id", "is_active", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Product categories (hierarchical via parent_id).",
  },
  product_packaging: {
    columns: ["id", "product_id", "name", "qty_in_base_uom", "is_purchase_default", "is_sales_default", "is_shipping_unit", "parent_packaging_id", "qty_in_parent", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description:
      "Alternate packs per product (e.g. 'Case of 12'). `qty_in_base_uom` is the conversion factor to the product's base unit. Never invent a pack factor — read it here.",
  },
  units_of_measure: {
    columns: ["id", "code", "name", "category_id", "factor_to_reference", "rounding", "uom_type", "is_active", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Units of measure. Join `products.base_uom_id` here to name the stocking unit.",
  },
  uom_categories: {
    columns: ["id", "name", "dimension", "reference_uom_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "UoM categories; conversion is only valid inside one category.",
  },
  warehouses: {
    columns: ["id", "code", "name", "city", "country", "is_default", "is_active", "is_in_transit", "branch_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Warehouses / stock sites.",
  },
  stock_locations: {
    columns: ["id", "code", "name", "warehouse_id", "parent_location_id", "location_type", "usage", "is_active", "is_blocked", "branch_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Bins / locations inside a warehouse.",
  },
  warehouse_stock: {
    columns: ["id", "warehouse_id", "product_id", "quantity", "reserved_quantity", "average_cost", "reorder_level", "reorder_quantity", "bin_location", "last_counted_at", "branch_id", "business_id", "updated_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "On-hand per product per warehouse, in the product's base unit. `average_cost` is the moving average unit cost for valuation.",
  },
  stock_quants: {
    columns: ["id", "product_id", "location_id", "lot_number", "quantity", "reserved_quantity", "branch_id", "business_id", "updated_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Authoritative on-hand per product/location/lot (base units). `reserved_quantity` is derived — available = quantity - reserved_quantity.",
  },
  stock_lots: {
    columns: ["id", "product_id", "lot_number", "serial_number", "manufacture_date", "expiry_date", "supplier_id", "goods_receipt_id", "notes", "is_active", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Lot / batch register with expiry dates. Quantities per lot live in `warehouse_stock_lots` and `stock_quants`.",
  },
  warehouse_stock_lots: {
    columns: ["id", "warehouse_id", "product_id", "lot_id", "quantity", "reserved_quantity", "business_id", "updated_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Quantity on hand per lot per warehouse.",
  },
  stock_serials: {
    columns: ["id", "product_id", "serial_number", "lot_number", "status", "current_warehouse_id", "current_location_id", "received_at", "shipped_at", "branch_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Serial-number register for serial-tracked products.",
  },
  stock_movements: {
    columns: ["id", "product_id", "movement_type", "quantity", "unit_cost", "reference_type", "reference_id", "movement_date", "notes", "warehouse_id", "lot_number", "serial_number", "display_quantity", "uom_snapshot_pack_name", "uom_snapshot_factor", "uom_snapshot_base_code", "source_location_id", "destination_location_id", "branch_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Stock ledger: every in/out movement in base units. `display_quantity` + `uom_snapshot_pack_name` record what the operator typed.",
  },
  stock_reservations: {
    columns: ["id", "product_id", "warehouse_id", "location_id", "lot_number", "quantity", "quantity_consumed", "status", "source_type", "source_id", "expires_at", "released_at", "branch_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Soft reservations against stock (orders, picks).",
  },
  stock_adjustments: {
    columns: ["id", "adjustment_number", "adjustment_date", "adjustment_type", "reason", "notes", "status", "warehouse_id", "approved_at", "branch_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Stock adjustment headers (counts, write-offs, corrections).",
  },
  stock_transfers: {
    columns: ["id", "transfer_number", "from_warehouse_id", "to_warehouse_id", "status", "transfer_date", "expected_arrival_date", "actual_arrival_date", "notes", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Inter-warehouse transfers.",
  },
  product_reorder_rules: {
    columns: ["id", "product_id", "min_quantity", "max_quantity", "warning_threshold", "critical_threshold", "safety_stock", "reorder_quantity", "lead_time_days", "preferred_supplier_id", "auto_create_po", "is_active", "branch_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Per-product replenishment rules.",
  },

  employees: {
    columns: ["id", "first_name", "last_name", "email", "department", "position", "status", "hire_date", "branch_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Employee register. Never project salary or bank details here.",
  },
  leave_requests: {
    columns: ["id", "employee_id", "leave_type", "start_date", "end_date", "status", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Leave requests.",
  },
  projects: {
    columns: ["id", "name", "status", "budget", "currency", "start_date", "deadline", "progress", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Projects and their budgets.",
  },
  project_tasks: {
    columns: ["id", "name", "project_id", "status", "priority", "due_date", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Project tasks.",
  },
  crm_leads: {
    columns: ["id", "name", "email", "stage", "expected_revenue", "currency", "probability", "created_at", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "CRM pipeline.",
  },
  estimates: {
    columns: ["id", "estimate_number", "status", "total", "currency", "issue_date", "valid_until", "contact_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Quotes / estimates.",
  },
  sales_orders: {
    columns: ["id", "order_number", "status", "total", "currency", "order_date", "contact_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Sales orders.",
  },
  purchase_orders: {
    columns: ["id", "po_number", "status", "total", "currency", "order_date", "expected_delivery_date", "contact_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Purchase orders.",
  },
  credit_notes: {
    columns: ["id", "credit_note_number", "status", "total", "amount_applied", "currency", "issue_date", "contact_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Customer credit notes.",
  },
  fixed_assets: {
    columns: ["id", "name", "asset_number", "purchase_price", "current_value", "currency", "status", "purchase_date", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Fixed asset register.",
  },
  accounts: {
    columns: ["id", "code", "name", "account_type", "currency", "is_active", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Chart of accounts.",
  },
  branches: {
    columns: ["id", "name", "code", "is_active", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Branches / locations.",
  },
  businesses: {
    columns: ["id", "name", "base_currency", "country", "is_active"],
    orgColumn: "organization_id",
    description: "Businesses in this organization, each with its own base currency.",
  },
  exchange_rates: {
    columns: ["id", "from_currency", "to_currency", "rate", "rate_date", "source", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Tenant rate book. Use this instead of guessing a conversion — never invent a rate.",
  },
  business_active_currencies: {
    columns: ["id", "business_id", "currency_code", "is_active"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Currencies switched on for transacting.",
  },
};

const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is_null", "not_null"] as const;
type Op = typeof OPS[number];

const MAX_LIMIT = 200;

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function buildDataToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "describe_schema",
        description:
          "List the tables and columns you may query, with a short description of each. Call this first when you are unsure which table or column holds what you need.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Optional: describe just this one table." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "query_data",
        description:
          "Run a read-only, tenant-scoped query against one allowed table. Use this instead of guessing numbers. Results are already filtered to the user's organization, business and permitted branches.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Table name from describe_schema." },
            columns: {
              type: "array",
              items: { type: "string" },
              description: "Columns to return. Omit for all allowed columns.",
            },
            filters: {
              type: "array",
              description: "Structured filters, ANDed together.",
              items: {
                type: "object",
                properties: {
                  column: { type: "string" },
                  op: { type: "string", enum: OPS as unknown as string[] },
                  value: { description: "Value for the operator; array for `in`; omit for is_null/not_null." },
                },
                required: ["column", "op"],
              },
            },
            order_by: { type: "string", description: "Column to sort by." },
            ascending: { type: "boolean", description: "Sort direction; defaults to descending." },
            limit: { type: "number", description: `Max rows (cap ${MAX_LIMIT}, default 25).` },
          },
          required: ["table"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_currency_context",
        description:
          "Return the workspace base currency, whether businesses disagree, the currencies enabled for transacting, and the latest rate-book entries. Call this before writing any monetary figure you are unsure about. Never assume a currency.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "count_rows",
        description:
          "Exact row count for one allowed table with the same structured filters as query_data. Use this before listing anything so you can say how many records exist instead of guessing or presenting a truncated list as complete.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string" },
            filters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  column: { type: "string" },
                  op: { type: "string", enum: OPS as unknown as string[] },
                  value: {},
                },
                required: ["column", "op"],
              },
            },
          },
          required: ["table"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_inventory_overview",
        description:
          "Complete live inventory picture: product/SKU counts, on-hand and stock valuation (org-wide and per warehouse), the highest-value products, low-stock and out-of-stock items, lot/expiry tracking coverage, lots expiring soon and already expired, and recent stock movement activity. Call this for ANY broad inventory, stock-value or expiry question.",
        parameters: {
          type: "object",
          properties: {
            warehouse_id: { type: "string", description: "Optional: restrict warehouse figures to one warehouse." },
            expiring_within_days: { type: "number", description: "Expiry horizon in days (default 90)." },
            top_n: { type: "number", description: "How many products to list in the ranked sections (default 15, max 50)." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_products",
        description:
          "The full product catalogue with stock, cost, valuation, tracking flags and unit of measure. Returns EVERY matching product (no small cap), so use it when the user asks for all products, a product list, or to find a product by name/SKU.",
        parameters: {
          type: "object",
          properties: {
            search: { type: "string", description: "Optional name or SKU fragment." },
            only_tracked: { type: "boolean", description: "Only inventory-tracked products." },
            include_inactive: { type: "boolean", description: "Include inactive/archived products (default false)." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_product_inventory",
        description:
          "Everything about ONE product: identity, base unit and pack conversions, tracking flags, on-hand and available per warehouse and per location, every lot/batch with expiry and remaining quantity, serials, valuation, and the most recent stock movements. Use this whenever the user names a specific product.",
        parameters: {
          type: "object",
          properties: {
            product_id: { type: "string", description: "Product uuid, when known." },
            search: { type: "string", description: "Product name or SKU when the id is unknown." },
          },
        },
      },
    },
  ];
}


function applyScope(query: any, spec: TableSpec, scope: ToolScope) {
  query = query.eq(spec.orgColumn, scope.organizationId);
  if (spec.businessColumn && scope.businessId) {
    query = query.eq(spec.businessColumn, scope.businessId);
  }
  if (spec.branchColumn && !scope.isAdmin && scope.accessibleBranchIds?.length) {
    query = query.in(spec.branchColumn, scope.accessibleBranchIds);
  }
  return query;
}

export async function executeDataTool(
  supabaseClient: any,
  name: string,
  rawArgs: Record<string, any>,
  scope: ToolScope,
  currencySummary: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === "get_currency_context") {
    const { data: rates } = await supabaseClient
      .from("exchange_rates")
      .select("from_currency, to_currency, rate, rate_date, source")
      .eq("organization_id", scope.organizationId)
      .order("rate_date", { ascending: false })
      .limit(25);
    return { ...currencySummary, recent_rates: rates ?? [] };
  }

  if (name === "describe_schema") {
    const only = typeof rawArgs?.table === "string" ? rawArgs.table : null;
    const entries = Object.entries(DATA_TABLES)
      .filter(([t]) => !only || t === only)
      .map(([table, spec]) => ({ table, description: spec.description, columns: spec.columns }));
    if (only && entries.length === 0) {
      return { error: `Unknown table "${only}".`, available: Object.keys(DATA_TABLES) };
    }
    return { tables: entries };
  }

  if (name !== "query_data") return { error: `Unknown tool "${name}".` };

  const table = String(rawArgs?.table ?? "");
  const spec = DATA_TABLES[table];
  if (!spec) {
    return { error: `Table "${table}" is not queryable.`, available: Object.keys(DATA_TABLES) };
  }

  const requested: string[] = Array.isArray(rawArgs?.columns) && rawArgs.columns.length
    ? rawArgs.columns.map(String)
    : spec.columns;
  const bad = requested.filter((c) => !spec.columns.includes(c));
  if (bad.length) {
    return { error: `Columns not allowed on ${table}: ${bad.join(", ")}`, allowed_columns: spec.columns };
  }

  let query = supabaseClient.from(table).select(requested.join(", "));
  query = applyScope(query, spec, scope);

  const filters = Array.isArray(rawArgs?.filters) ? rawArgs.filters : [];
  for (const f of filters) {
    const col = String(f?.column ?? "");
    const op = String(f?.op ?? "") as Op;
    if (!spec.columns.includes(col)) {
      return { error: `Filter column "${col}" is not allowed on ${table}.`, allowed_columns: spec.columns };
    }
    if (!OPS.includes(op)) {
      return { error: `Unsupported operator "${op}".`, allowed_operators: OPS };
    }
    if (op === "is_null") query = query.is(col, null);
    else if (op === "not_null") query = query.not(col, "is", null);
    else if (op === "in") query = query.in(col, Array.isArray(f.value) ? f.value : [f.value]);
    else query = (query as any)[op](col, f.value);
  }

  if (rawArgs?.order_by) {
    const col = String(rawArgs.order_by);
    if (!spec.columns.includes(col)) {
      return { error: `Order column "${col}" is not allowed on ${table}.`, allowed_columns: spec.columns };
    }
    query = query.order(col, { ascending: rawArgs.ascending === true });
  }

  const limit = Math.min(Math.max(parseInt(String(rawArgs?.limit ?? 25), 10) || 25, 1), MAX_LIMIT);
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error(`query_data(${table}) failed`, error);
    return { error: `Query failed: ${error.message}` };
  }

  return {
    table,
    row_count: (data ?? []).length,
    truncated: (data ?? []).length >= limit,
    scope: {
      organization_id: scope.organizationId,
      business_id: scope.businessId ?? null,
      branch_filtered: Boolean(spec.branchColumn && !scope.isAdmin && scope.accessibleBranchIds?.length),
    },
    rows: data ?? [],
  };
}

export const DATA_TOOLS_PROMPT = `
## 🔎 Live data access (tools)

You are NOT limited to the snapshot above. You can query this workspace's live
database with tools, and you MUST do so rather than guessing, extrapolating, or
saying you have no access:

- \`describe_schema\` — list the tables and columns you may read.
- \`query_data\` — read rows from one table with structured filters, ordering and a limit.
- \`get_currency_context\` — the workspace base currency, enabled currencies and the rate book.

Rules:
1. If a question needs a number you cannot see in the snapshot, call \`query_data\` before answering.
2. Never state a figure you did not read from the snapshot or a tool result. If a
   query returns nothing, say so plainly.
3. Never convert between currencies yourself. Read the rate from
   \`get_currency_context\`/\`exchange_rates\`; if there is no rate on file, say the
   rate book has no rate for that pair and date — do NOT use 1:1 or an assumed rate.
4. Queries are automatically scoped to the user's organization, selected business and
   permitted branches. Everything is read-only: you cannot change data. If the user
   asks you to create, edit, post or delete something, explain what needs doing and
   point them at the right screen with an action button instead.
5. Results carry \`truncated: true\` when the row cap was hit — say the list is partial
   rather than presenting it as complete.
`;

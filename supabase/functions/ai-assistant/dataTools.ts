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
 *   7. Module capability gate. Every table and tool read is checked against the
 *      caller's own module permissions (see `capabilities.ts`).
 */

import {
  type CapabilitySet,
  canReadModule,
  canReadTable,
  readableTables,
  TABLE_MODULE,
  TOOL_MODULE,
} from "./capabilities.ts";


export interface ToolScope {
  organizationId: string;
  businessId?: string | null;
  branchId?: string | null;
  /**
   * Branch ids the caller may see. Fail-CLOSED: for a non-admin an empty list
   * means "no branch is visible", not "all branches".
   */
  accessibleBranchIds?: string[];
  isAdmin: boolean;
  /** Modules this caller may read; resolved server-side per request. */
  capabilities: CapabilitySet;
}


interface TableSpec {
  /** Columns the model may project and filter on. */
  columns: string[];
  /**
   * Column holding the organization id, when the table carries one. Purely
   * business-scoped tables (the microfinance chain) omit it and are narrowed by
   * `businessColumn` against the caller's permitted businesses instead.
   */
  orgColumn?: string;
  /** Column holding the business id, when the table is business-scoped. */
  businessColumn?: string;
  /** Column holding the branch id, for non-admin narrowing. */
  branchColumn?: string;
  /** Human description shown to the model by describe_schema. */
  description: string;
}

export const DATA_TABLES: Record<string, TableSpec> = {
  // ─── Microfinance core ────────────────────────────────────────────────────
  mf_clients: {
    columns: ["id", "client_number", "full_name", "national_id", "gender", "phone", "email", "occupation", "business_type", "business_location", "physical_address", "loan_officer_id", "joined_on", "status", "completed_cycles", "branch_id", "business_id", "created_at"],
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Microfinance borrowers. `status` covers the client lifecycle; `completed_cycles` is how many loan cycles they have finished. Never project identity document paths.",
  },
  mf_groups: {
    columns: ["id", "group_number", "name", "loan_officer_id", "meeting_day", "meeting_time", "meeting_place", "formed_on", "status", "branch_id", "business_id", "created_at"],
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Borrower groups (group lending) and their meeting schedule.",
  },
  mf_loan_applications: {
    columns: ["id", "application_number", "client_id", "group_id", "product_id", "loan_officer_id", "requested_amount", "requested_term_installments", "purpose", "status", "submitted_at", "approved_amount", "approved_term_installments", "decision_at", "decision_notes", "rejection_reason", "branch_id", "business_id", "created_at"],
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Loan applications and their approval decisions. Requested vs approved amounts may differ — quote the one the question asks for.",
  },
  mf_loans: {
    columns: ["id", "loan_number", "application_id", "client_id", "group_id", "product_id", "loan_officer_id", "currency_code", "principal", "term_installments", "repayment_frequency", "interest_method", "interest_rate", "interest_rate_period", "grace_period_installments", "penalty_rate", "penalty_basis", "expected_disbursement_date", "first_installment_date", "status", "disbursed_at", "closed_at", "branch_id", "business_id", "created_at"],
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "The loan book. `principal` is the disbursed/approved principal in `currency_code`; outstanding balances are derived from the schedule and repayments, never stored here.",
  },
  mf_repayments: {
    columns: ["id", "receipt_number", "loan_id", "client_id", "batch_id", "paid_on", "amount", "method", "reference", "status", "reversal_reason", "reversed_at", "received_by", "branch_id", "business_id", "created_at"],
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Repayment receipts against loans. Reversed receipts keep a row — exclude `status = 'reversed'` when totalling collections.",
  },

  // ─── Finance / accounting ─────────────────────────────────────────────────
  expenses: {
    columns: ["id", "description", "amount", "currency", "expense_date", "status", "category_id", "vendor_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Recorded expenses.",
  },
  payments: {
    columns: ["id", "amount", "payment_date", "payment_method", "reference", "receipt_number", "status", "contact_id", "outstanding_amount", "applied_amount", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Payments recorded in the workspace base currency. Loan repayments live in mf_repayments, not here.",
  },
  accounts: {
    columns: ["id", "code", "name", "account_type", "detail_type", "is_header", "is_active", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Chart of accounts (structure only). Do NOT derive balances here — account balances come from posted journal entries and are already summarised in the snapshot.",
  },
  journal_entries: {
    columns: ["id", "entry_number", "entry_date", "status", "description", "reference", "source_module", "currency", "total_debit", "total_credit", "posted_at", "branch_id", "business_id", "created_at"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Journal entry headers. Only `status = 'posted'` entries affect the ledger; drafts must never be quoted as balances.",
  },
  fixed_assets: {
    columns: ["id", "name", "asset_number", "purchase_price", "accumulated_depreciation", "book_value", "status", "purchase_date", "disposal_date", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Fixed asset register.",
  },

  // ─── Treasury ─────────────────────────────────────────────────────────────
  bank_accounts: {
    // NOTE: this table stores no running balance column at all. A balance is a
    // projection (`bank_account_positions`), never a stored column — the
    // assistant's snapshot already carries the positions.
    columns: ["id", "name", "bank_name", "account_number", "currency", "opening_balance", "bank_reported_balance", "bank_balance_as_of", "is_primary", "is_active", "lifecycle_status", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Bank account master data in the account's own `currency`. This table holds NO current balance: `opening_balance` is the day-one figure and `bank_reported_balance` is the bank's own last reported figure as at `bank_balance_as_of`. For an actual cash position use the Bank Accounts section of the snapshot, which comes from the `bank_account_positions` projection.",
  },
  bank_transactions: {
    columns: ["id", "bank_account_id", "transaction_date", "posting_date", "description", "reference", "amount", "transaction_type", "is_reconciled", "reconciled_at", "lifecycle_status", "original_currency", "original_amount", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Bank statement lines.",
  },
  exchange_rates: {
    columns: ["id", "from_currency", "to_currency", "rate", "effective_date", "source", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Tenant rate book. Use this instead of guessing a conversion — never invent a rate.",
  },

  // ─── Parties, people, organisation ────────────────────────────────────────
  contacts: {
    columns: ["id", "name", "email", "phone", "type", "is_company", "default_currency", "is_active", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    description: "Suppliers, service providers and other non-borrower parties. Borrowers live in mf_clients.",
  },
  employees: {
    columns: ["id", "employee_number", "first_name", "last_name", "email", "work_email", "department_id", "job_position_id", "employment_type", "lifecycle_status", "is_active", "hire_date", "termination_date", "branch_id", "business_id"],
    orgColumn: "organization_id",
    businessColumn: "business_id",
    branchColumn: "branch_id",
    description: "Staff register (loan officers, tellers, back office). Never project salary or bank details here.",
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
  business_active_currencies: {
    columns: ["id", "business_id", "currency_code", "is_enabled"],
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

/**
 * The tool catalogue. When `caps` is supplied the model is only told about
 * tools it may actually use, so it never proposes a capability the gate would
 * refuse. The gate in `executeDataTool` is re-checked per invocation regardless.
 */
export function buildDataToolSpecs(caps?: CapabilitySet): ToolSpec[] {
  const all: ToolSpec[] = [

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
  ];

  if (!caps) return all;
  return all.filter((t) => {
    const name = t.function.name;
    if (!(name in TOOL_MODULE)) return false; // deny by default
    if (!canReadModule(caps, TOOL_MODULE[name])) return false;
    // Generic table tools are pointless with no readable table.
    if ((name === "query_data" || name === "count_rows") &&
        readableTables(caps, Object.keys(DATA_TABLES)).length === 0) return false;
    return true;
  });
}



/** A uuid that cannot exist, used to make a fail-closed filter return no rows. */
const IMPOSSIBLE_UUID = "00000000-0000-0000-0000-000000000000";

function applyScope(query: any, spec: TableSpec, scope: ToolScope) {
  query = query.eq(spec.orgColumn, scope.organizationId);
  if (spec.businessColumn && scope.businessId) {
    query = query.eq(spec.businessColumn, scope.businessId);
  }
  // FAIL CLOSED: a non-admin with no viewable branches reads nothing from a
  // branch-scoped table. The previous `&& length` guard silently returned every
  // branch for a user who had no branch assignment at all.
  if (spec.branchColumn && !scope.isAdmin) {
    const ids = scope.accessibleBranchIds ?? [];
    query = query.in(spec.branchColumn, ids.length ? ids : [IMPOSSIBLE_UUID]);
  }
  return query;
}

/** Whether branch narrowing is in force for this table/caller. */
function branchFiltered(spec: TableSpec | undefined, scope: ToolScope): boolean {
  return Boolean(spec?.branchColumn && !scope.isAdmin);
}

/** Structured refusal handed back to the model when a capability is missing. */
function notPermitted(subject: string, module: string | null | undefined) {
  return {
    error: "not_permitted",
    subject,
    module: module ?? null,
    message:
      `You do not have permission to read ${subject}` +
      (module ? ` (module: ${module})` : "") +
      ". Tell the user this data is outside their access rights and do not guess a figure.",
  };
}


/** Apply the model's structured filters; returns an error object when invalid. */
function applyFilters(query: any, spec: TableSpec, table: string, filters: any[]): { query?: any; error?: Record<string, unknown> } {
  for (const f of filters) {
    const col = String(f?.column ?? "");
    const op = String(f?.op ?? "") as Op;
    if (!spec.columns.includes(col)) {
      return { error: { error: `Filter column "${col}" is not allowed on ${table}.`, allowed_columns: spec.columns } };
    }
    if (!OPS.includes(op)) {
      return { error: { error: `Unsupported operator "${op}".`, allowed_operators: OPS } };
    }
    if (op === "is_null") query = query.is(col, null);
    else if (op === "not_null") query = query.not(col, "is", null);
    else if (op === "in") query = query.in(col, Array.isArray(f.value) ? f.value : [f.value]);
    else query = (query as any)[op](col, f.value);
  }
  return { query };
}


export async function executeDataTool(
  supabaseClient: any,
  name: string,
  rawArgs: Record<string, any>,
  scope: ToolScope,
  currencySummary: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const caps = scope.capabilities;

  // ---- Capability gate (deny by default) -----------------------------------
  if (!(name in TOOL_MODULE)) return { error: `Unknown tool "${name}".` };
  if (!canReadModule(caps, TOOL_MODULE[name])) {
    return notPermitted(`the ${name} tool`, TOOL_MODULE[name]);
  }

  if (name === "get_currency_context") {
    // `effective_date` is the real column; the previous (non-existent) one
    // returned nothing and left the model to invent a rate.
    const { data: rates, error } = await supabaseClient
      .from("exchange_rates")
      .select("from_currency, to_currency, rate, effective_date, source")
      .eq("organization_id", scope.organizationId)
      .order("effective_date", { ascending: false })
      .limit(25);
    if (error) {
      return {
        ...currencySummary,
        recent_rates_error: `Rate book unavailable (${error.message}). Do NOT convert or quote a rate.`,
      };
    }
    return { ...currencySummary, recent_rates: rates ?? [] };
  }

  if (name === "describe_schema") {
    // The model is only shown the tables this caller may read, so it cannot
    // even learn the shape of a module that is off limits.
    const allowed = readableTables(caps, Object.keys(DATA_TABLES));
    const only = typeof rawArgs?.table === "string" ? rawArgs.table : null;
    if (only && !allowed.includes(only)) {
      return DATA_TABLES[only]
        ? notPermitted(`the ${only} table`, TABLE_MODULE[only])
        : { error: `Unknown table "${only}".`, available: allowed };
    }
    const entries = allowed
      .filter((t) => !only || t === only)
      .map((table) => ({
        table,
        description: DATA_TABLES[table].description,
        columns: DATA_TABLES[table].columns,
      }));
    return { tables: entries };
  }

  if (name !== "query_data" && name !== "count_rows") return { error: `Unknown tool "${name}".` };

  const table = String(rawArgs?.table ?? "");
  const spec = DATA_TABLES[table];
  if (!spec) {
    return {
      error: `Table "${table}" is not queryable.`,
      available: readableTables(caps, Object.keys(DATA_TABLES)),
    };
  }
  if (!canReadTable(caps, table)) {
    return notPermitted(`the ${table} table`, TABLE_MODULE[table]);
  }

  const filters = Array.isArray(rawArgs?.filters) ? rawArgs.filters : [];

  if (name === "count_rows") {
    let countQuery = supabaseClient.from(table).select(spec.orgColumn, { count: "exact", head: true });
    countQuery = applyScope(countQuery, spec, scope);
    const applied = applyFilters(countQuery, spec, table, filters);
    if (applied.error) return applied.error;
    const { count, error } = await applied.query;
    if (error) {
      console.error(`count_rows(${table}) failed`, error);
      return { error: `Count failed: ${error.message}` };
    }
    return {
      table,
      count: count ?? 0,
      scope: {
        organization_id: scope.organizationId,
        business_id: scope.businessId ?? null,
        branch_filtered: branchFiltered(spec, scope),
      },
    };
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

  const applied = applyFilters(query, spec, table, filters);
  if (applied.error) return applied.error;
  query = applied.query;

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
      branch_filtered: branchFiltered(spec, scope),
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
- \`count_rows\` — count matching rows without pulling them back.

- \`get_currency_context\` — the workspace base currency, enabled currencies and the rate book.

Only the tools you are offered are available to this user; the catalogue is
narrowed to what their permissions allow.

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
6. A \`not_permitted\` result means this user may not read that module. Say so
   plainly, name nothing from it, and never estimate the figure instead.

`;

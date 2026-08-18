import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buildCurrencyRulePrompt,
  formatMoney,
  formatRecordMoney,
  resolveWorkspaceCurrency,
  UNRESOLVED_CURRENCY_CONTEXT,
  type WorkspaceCurrencyContext,
} from "../_shared/workspaceCurrency.ts";
import {
  buildDataToolSpecs,
  executeDataTool,
  DATA_TOOLS_PROMPT,
  type ToolScope,
  type ToolSpec,
} from "./dataTools.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ─── Route catalog & action-block protocol (mirrors src/lib/ai/*) ───────────
// Kept in sync by hand. The CLIENT also has a copy to validate ids when
// rendering buttons; the server lists them in the system prompt so the
// model only emits ids that resolve.
const ROUTE_CATALOG_ENTRIES: Array<{ id: string; label: string; path: string; description: string }> = [
  { id: "payroll.overview",        label: "Payroll Overview",        path: "/hr/payroll",                              description: "Payroll dashboard: readiness, next pay run, pending issues." },
  { id: "payroll.runs",            label: "Payroll Runs",            path: "/hr/payroll/runs",                         description: "List of pay runs / batches." },
  { id: "payroll.payslips",        label: "Payslips",                path: "/hr/payroll/payslips",                     description: "Generated payslips, statuses, downloads." },
  { id: "payroll.payments",        label: "Payroll Payments",        path: "/hr/payroll/payments",                     description: "Mark payroll as paid; payment batches." },
  { id: "payroll.gl_mappings",     label: "GL Account Mapping",      path: "/hr/payroll/configuration/accounts",       description: "Map every payroll posting key to a chart-of-accounts entry." },
  { id: "payroll.salary_structures", label: "Salary Structures",     path: "/hr/payroll/configuration/structures",     description: "Define salary structures and rules." },
  { id: "payroll.statutory_rules", label: "Statutory Rules",         path: "/hr/payroll/statutory-rules",              description: "Active country-specific statutory rules." },
  { id: "payroll.configuration",   label: "Payroll Configuration",   path: "/hr/payroll/configuration",                description: "All payroll settings: schedules, structures, accounts." },
  { id: "payroll.setup",           label: "Payroll Setup",           path: "/hr/payroll/setup",                        description: "Guided payroll setup wizard." },
  { id: "payroll.loans",           label: "Employee Loans",          path: "/hr/payroll/loans",                        description: "Employee loan records and recoveries." },
  { id: "payroll.remittances",     label: "Remittance Tracking",     path: "/hr/remittances",                          description: "Statutory remittances per period." },
  { id: "hr.employees",            label: "Employees",               path: "/hr/employees",                            description: "Employee directory and records." },
  { id: "hr.attendance",           label: "Attendance",              path: "/hr/attendance",                           description: "Attendance records and check-ins." },
  { id: "hr.time_off",             label: "Time Off",                path: "/hr/leave",                                description: "Leave requests, balances, approvals." },
  { id: "finance.chart_of_accounts", label: "Chart of Accounts",     path: "/finance/accounts",                        description: "All ledger accounts." },
  { id: "finance.journals",        label: "Journal Entries",         path: "/finance/journal-entries",                 description: "All posted and draft journal entries." },
  { id: "settings.localization",   label: "Localization Settings",   path: "/settings/workspace?tab=localization", description: "Configure country localization for this workspace (currency, date format, statutory pack selection)." },
  { id: "settings.access_groups",  label: "Access Groups",           path: "/settings/workspace?tab=access-groups", description: "Roles and permissions for users in this workspace." },
  { id: "settings.businesses",     label: "Companies & Branches",    path: "/settings/company?tab=company",        description: "Multi-business / branch configuration." },
  { id: "apps.marketplace",        label: "Apps Marketplace",        path: "/apps",                                    description: "Browse, install, and configure apps." },
];

const ROUTE_CATALOG_PROMPT = [
  "AVAILABLE_NAVIGATION_TARGETS (only these ids may be used in action blocks):",
  ...ROUTE_CATALOG_ENTRIES.map(e => `- ${e.id} → ${e.label} (${e.path}) — ${e.description}`),
].join("\n");

const ACTION_BLOCK_PROTOCOL_PROMPT = `
ACTION BLOCKS:
When you want the user to perform an action, append one or more action lines AFTER your normal markdown answer.
Each action line MUST be on its own line and MUST start with the literal prefix "::action " followed by valid JSON.

Supported action types:
1) Navigate (path_id MUST come from AVAILABLE_NAVIGATION_TARGETS):
   ::action {"type":"open_path","path_id":"<id>","label":"<button text>"}
2) Open the GL mapping fixer dialog (when payroll posting is blocked by missing mappings):
   ::action {"type":"fix_gl_mappings","label":"Fix payroll mappings now"}
3) Open the install/activate dialog for an app:
   ::action {"type":"open_install_dialog","app_id":"<app id>","label":"Install <App>"}

Rules:
- NEVER invent a path_id. Only ids from AVAILABLE_NAVIGATION_TARGETS are valid.
- At most 3 action blocks per reply.
- Write the human explanation FIRST in markdown, then put action lines on their own lines at the end.
- Do not wrap action lines in code fences.
`.trim();

/**
 * Pull a *live* payroll diagnostics snapshot for the current org so the
 * assistant can answer "why won't payroll post?" without asking.
 */
async function buildPayrollDiagnostics(
  supabaseClient: any,
  orgId: string,
  businessId?: string,
): Promise<string | null> {
  try {
    const [{ data: readiness }, { data: setup }, { data: packs }] = await Promise.all([
      supabaseClient.rpc("payroll_gl_readiness", { _org_id: orgId, _business_id: businessId ?? null }),
      supabaseClient
        .from("app_setup_status")
        .select("status, blocking_reasons")
        .eq("organization_id", orgId)
        .eq("app_id", "payroll")
        .maybeSingle(),
      supabaseClient
        .from("installed_localization_packs")
        .select("pack_id, pack_version, status, localization_packs(name, country_code)")
        .eq("organization_id", orgId)
        .eq("status", "active"),
    ]);

    const missing = (readiness ?? []).filter((r: any) => !r.is_mapped);
    const totalKeys = (readiness ?? []).length;
    const installedSummary = (packs ?? [])
      .map((p: any) => `${p.localization_packs?.name ?? p.pack_id} (${p.localization_packs?.country_code ?? "?"}) v${p.pack_version}`)
      .join(", ") || "none";

    // ── Latest blocked / approved-but-unposted run, if any ──
    let blockedLine = "- No blocked payroll runs.";
    let blockedActionHint = "";
    try {
      let runQuery = supabaseClient
        .from("payroll_runs")
        .select("id, payroll_number, status, business_id")
        .eq("organization_id", orgId)
        .in("status", ["approved", "posting_failed"])
        .order("updated_at", { ascending: false })
        .limit(1);
      if (businessId) runQuery = runQuery.eq("business_id", businessId);
      const { data: blockedRuns } = await runQuery;
      const blocked = (blockedRuns ?? [])[0];
      if (blocked) {
        const { data: validation } = await supabaseClient.rpc(
          "validate_payroll_run_mappings",
          { p_run_id: blocked.id },
        );
        const ok = !!validation?.ok;
        const missingKeys: string[] = validation?.missing_keys ?? [];
        if (!ok) {
          blockedLine =
            `- Latest blocked run: ${blocked.payroll_number} (${blocked.id}), status=${blocked.status}, ` +
            `${missingKeys.length} missing mapping(s): ${missingKeys.slice(0, 10).join(", ")}`;
          blockedActionHint =
            `When the user asks why payroll won't post, propose action ` +
            `\`fix_gl_mappings\` with payroll_run_id="${blocked.id}" so the dialog opens with run-specific rows.`;
        } else {
          blockedLine =
            `- Latest unposted run: ${blocked.payroll_number} (${blocked.id}), status=${blocked.status}, ` +
            `mappings OK — likely a different blocker (work entries, period lock, permission).`;
        }
      }
    } catch (_) { /* swallow — diagnostics is best-effort */ }

    return [
      "LIVE_PAYROLL_DIAGNOSTICS:",
      `- Installed localization packs: ${installedSummary}`,
      `- Payroll setup status: ${setup?.status ?? "unknown"}`,
      setup?.blocking_reasons?.length
        ? `- Blocking reasons: ${JSON.stringify(setup.blocking_reasons)}`
        : `- Blocking reasons: none`,
      `- GL mapping keys total/missing (setup-wide): ${totalKeys} / ${missing.length}`,
      missing.length
        ? `- Missing mapping labels (setup-wide): ${missing.slice(0, 20).map((m: any) => m.label).join("; ")}`
        : `- All setup-wide payroll GL mappings are configured.`,
      blockedLine,
      "",
      "When the user is blocked by missing GL mappings, propose the action `fix_gl_mappings` AND link to `payroll.gl_mappings`.",
      blockedActionHint,
    ].filter(Boolean).join("\n");
  } catch (e) {
    console.error("buildPayrollDiagnostics failed:", e);
    return null;
  }
}

interface AIRequest {
  type: "categorize_expense" | "analyze_invoice" | "financial_insights" | "chat" | "suggest_actions" | "email_assist" | "match_transactions" | "document_text";
  data?: Record<string, any>;
  messages?: Array<{ role: string; content: string }>;
  organizationId?: string;
  businessId?: string;
  branchId?: string;
  userRole?: string;
  accessibleBranchIds?: string[];
  currentPage?: string;
}

interface ProviderConfig {
  id: string;
  provider_code: string;
  base_url: string;
  default_model: string | null;
  priority: number;
}

interface ApiKeyConfig {
  id: string;
  provider_id: string;
  vault_secret_id: string | null;
  priority: number;
  last_rate_limited_at: string | null;
}

interface FinancialContext {
  organization: any;
  bankAccounts: any[];
  recentInvoices: any[];
  recentExpenses: any[];
  recentPayments: any[];
  pendingBills: any[];
  contacts: any[];
  // Extended data
  products: any[];
  lowStockProducts: any[];
  employees: any[];
  leaveRequests: any[];
  projects: any[];
  projectTasks: any[];
  crmLeads: any[];
  fixedAssets: any[];
  posTransactions: any[];
  estimates: any[];
  salesOrders: any[];
  creditNotes: any[];
  purchaseOrders: any[];
  accounts: any[];
  summary: {
    totalBankBalance: number;
    totalReceivables: number;
    totalPayables: number;
    overdueReceivables: number;
    recentRevenue: number;
    recentExpenses: number;
    // Extended summaries
    totalProducts: number;
    lowStockCount: number;
    totalEmployees: number;
    pendingLeaveRequests: number;
    activeProjects: number;
    openLeads: number;
    totalAssetValue: number;
    todayPOSSales: number;
  };
}

// Check if user has admin-level access
function isAdminRole(role: string | undefined): boolean {
  return ['super_admin', 'owner', 'admin'].includes(role || '');
}

// Fetch financial context for the organization with branch filtering
async function getFinancialContext(
  supabaseClient: any, 
  organizationId: string,
  businessId?: string,
  branchId?: string,
  userRole?: string,
  accessibleBranchIds?: string[]
): Promise<FinancialContext | null> {
  if (!organizationId) return null;

  const isAdmin = isAdminRole(userRole);
  const branchIds = accessibleBranchIds?.length ? accessibleBranchIds : (branchId ? [branchId] : []);

  try {
    const today = new Date().toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Build POS transactions query based on access level
    let posTransactionsQuery = supabaseClient
      .from("pos_transactions")
      .select(`
        id, transaction_number, total, payment_status, created_at,
        register:pos_registers(id, register_code, branch_id, branch:branches(id, name))
      `)
      .eq("organization_id", organizationId)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(100);

    // For non-admin users, filter by accessible branches
    if (!isAdmin && branchIds.length > 0) {
      // We'll filter client-side since the nested filter is complex
    }

    // Helper to conditionally add business_id filter
    const biz = (query: any) => {
      if (businessId) return query.eq("business_id", businessId);
      return query;
    };

    // Fetch all data in parallel - extended to include all system data
    const [
      orgResult,
      bankResult,
      invoicesResult,
      expensesResult,
      paymentsResult,
      billsResult,
      contactsResult,
      productsResult,
      lowStockResult,
      employeesResult,
      leaveRequestsResult,
      projectsResult,
      projectTasksResult,
      crmLeadsResult,
      fixedAssetsResult,
      posTransactionsResult,
      estimatesResult,
      salesOrdersResult,
      creditNotesResult,
      purchaseOrdersResult,
      accountsResult,
      branchesResult,
      businessResult,
    ] = await Promise.all([
      // Organization info
      supabaseClient
        .from("organizations")
        .select("name, email, phone, address, city, country")
        .eq("id", organizationId)
        .single(),
      
      // Bank accounts with balances
      biz(supabaseClient
        .from("bank_accounts")
        .select("id, name, bank_name, current_balance, currency, is_primary")
        .eq("organization_id", organizationId)
        .eq("is_active", true)),
      
      // Recent invoices (last 30 days + all unpaid)
      biz(supabaseClient
        .from("invoices")
        .select(`
          id, invoice_number, status, total, amount_paid, due_date, issue_date,
          contact:contacts(name, company, email)
        `)
        .eq("organization_id", organizationId)
        .or(`issue_date.gte.${thirtyDaysAgo},status.in.(draft,sent,overdue,partial)`)
        .order("issue_date", { ascending: false })
        .limit(50)),
      
      // Recent expenses (last 30 days)
      biz(supabaseClient
        .from("expenses")
        .select(`
          id, description, amount, expense_date, status,
          category:expense_categories(name),
          vendor:contacts(name)
        `)
        .eq("organization_id", organizationId)
        .gte("expense_date", thirtyDaysAgo)
        .order("expense_date", { ascending: false })
        .limit(50)),
      
      // Recent payments received (last 30 days)
      biz(supabaseClient
        .from("payments")
        .select(`
          id, amount, payment_date, payment_method, receipt_number,
          contact:contacts(name),
          invoice:invoices(invoice_number)
        `)
        .eq("organization_id", organizationId)
        .gte("payment_date", thirtyDaysAgo)
        .order("payment_date", { ascending: false })
        .limit(30)),
      
      // Pending bills
      biz(supabaseClient
        .from("bills")
        .select(`
          id, bill_number, total, amount_paid, due_date, status,
          vendor:contacts(name, company)
        `)
        .eq("organization_id", organizationId)
        .in("status", ["draft", "pending", "partial", "overdue"])
        .order("due_date", { ascending: true })
        .limit(30)),
      
      // Top contacts
      biz(supabaseClient
        .from("contacts")
        .select("id, name, company, email, type")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .limit(20)),

      // Products summary. NOTE: the physical columns are `unit_price` and
      // `stock_quantity` — the older `selling_price`/`quantity_on_hand` names
      // do not exist and made this whole query (and therefore the assistant's
      // product knowledge) come back empty.
      biz(supabaseClient
        .from("products")
        .select("id, name, sku, type, unit_price, cost_price, stock_quantity, reorder_level, track_inventory, is_lot_tracked, is_expiry_tracked, is_serial_tracked, is_active")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .limit(200)),

      // Low stock products
      biz(supabaseClient
        .from("products")
        .select("id, name, sku, stock_quantity, reorder_level")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .eq("track_inventory", true)
        .limit(200)),


      // Employees
      biz(supabaseClient
        .from("employees")
        .select("id, first_name, last_name, email, department, position, status, hire_date, branch_id")
        .eq("organization_id", organizationId)
        .eq("status", "active")
        .limit(50)),

      // Leave requests (pending)
      supabaseClient
        .from("leave_requests")
        .select(`
          id, leave_type, start_date, end_date, status, reason,
          employee:employees(first_name, last_name, branch_id)
        `)
        .eq("organization_id", organizationId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(20),

      // Projects
      biz(supabaseClient
        .from("projects")
        .select("id, name, status, budget, start_date, deadline, progress")
        .eq("organization_id", organizationId)
        .in("status", ["planning", "in_progress", "on_hold"])
        .order("deadline", { ascending: true })
        .limit(20)),

      // Project tasks (pending/in progress)
      supabaseClient
        .from("project_tasks")
        .select(`
          id, name, status, priority, due_date,
          project:projects(name)
        `)
        .eq("organization_id", organizationId)
        .in("status", ["todo", "in_progress"])
        .order("due_date", { ascending: true })
        .limit(30),

      // CRM Leads
      supabaseClient
        .from("crm_leads")
        .select("id, name, email, stage, expected_revenue, probability, created_at")
        .eq("organization_id", organizationId)
        .not("stage", "in", "(won,lost)")
        .order("expected_revenue", { ascending: false })
        .limit(20),

      // Fixed Assets
      biz(supabaseClient
        .from("fixed_assets")
        .select("id, name, asset_number, purchase_price, current_value, status, purchase_date")
        .eq("organization_id", organizationId)
        .eq("status", "active")
        .limit(30)),

      // POS Transactions (last 7 days) - includes branch info
      posTransactionsQuery,

      // Estimates (pending/sent)
      biz(supabaseClient
        .from("estimates")
        .select(`
          id, estimate_number, status, total, valid_until,
          contact:contacts(name, company)
        `)
        .eq("organization_id", organizationId)
        .in("status", ["draft", "sent"])
        .order("valid_until", { ascending: true })
        .limit(20)),

      // Sales Orders (pending)
      biz(supabaseClient
        .from("sales_orders")
        .select(`
          id, order_number, status, total, order_date,
          contact:contacts(name, company)
        `)
        .eq("organization_id", organizationId)
        .in("status", ["draft", "confirmed", "processing"])
        .order("order_date", { ascending: false })
        .limit(20)),

      // Credit Notes
      biz(supabaseClient
        .from("credit_notes")
        .select(`
          id, credit_note_number, status, total, amount_applied,
          contact:contacts(name, company)
        `)
        .eq("organization_id", organizationId)
        .in("status", ["draft", "issued"])
        .limit(20)),

      // Purchase Orders (pending)
      biz(supabaseClient
        .from("purchase_orders")
        .select(`
          id, po_number, status, total, expected_delivery_date,
          vendor:contacts(name, company)
        `)
        .eq("organization_id", organizationId)
        .in("status", ["draft", "sent", "confirmed"])
        .order("expected_delivery_date", { ascending: true })
        .limit(20)),

      // Accounts summary
      supabaseClient
        .from("accounts")
        .select("id, name, code, account_type, current_balance, is_active")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .order("code")
        .limit(50),

      // Branches - for admin multi-branch summary
      supabaseClient
        .from("branches")
        .select("id, name, code, is_headquarters")
        .eq("organization_id", organizationId)
        .eq("is_active", true),

      // Get business name if businessId is set
      businessId
        ? supabaseClient
            .from("businesses")
            .select("name")
            .eq("id", businessId)
            .single()
        : Promise.resolve({ data: null }),
    ]);

    // Calculate summary metrics
    const bankAccounts = bankResult.data || [];
    const invoices = invoicesResult.data || [];
    const expenses = expensesResult.data || [];
    const payments = paymentsResult.data || [];
    const bills = billsResult.data || [];
    const products = productsResult.data || [];
    const lowStockProducts = (lowStockResult.data || []).filter((p: any) => 
      p.quantity_on_hand <= (p.reorder_level || 0)
    );
    let employees = employeesResult.data || [];
    let leaveRequests = leaveRequestsResult.data || [];
    const projects = projectsResult.data || [];
    const projectTasks = projectTasksResult.data || [];
    const crmLeads = crmLeadsResult.data || [];
    const fixedAssets = fixedAssetsResult.data || [];
    let posTransactions = posTransactionsResult.data || [];
    const estimates = estimatesResult.data || [];
    const salesOrders = salesOrdersResult.data || [];
    const creditNotes = creditNotesResult.data || [];
    const purchaseOrders = purchaseOrdersResult.data || [];
    const accounts = accountsResult.data || [];
    const branches = branchesResult.data || [];

    // Apply branch filtering for non-admin users
    if (!isAdmin && branchIds.length > 0) {
      // Filter POS transactions by branch
      posTransactions = posTransactions.filter((t: any) => 
        t.register?.branch_id && branchIds.includes(t.register.branch_id)
      );

      // Filter employees by branch
      employees = employees.filter((e: any) => 
        !e.branch_id || branchIds.includes(e.branch_id)
      );

      // Filter leave requests by employee's branch
      leaveRequests = leaveRequests.filter((lr: any) => 
        !lr.employee?.branch_id || branchIds.includes(lr.employee.branch_id)
      );
    }

    const totalBankBalance = bankAccounts.reduce((sum: number, acc: any) => sum + (acc.current_balance || 0), 0);
    
    const unpaidInvoices = invoices.filter((inv: any) => 
      ["sent", "overdue", "partial"].includes(inv.status)
    );
    const totalReceivables = unpaidInvoices.reduce((sum: number, inv: any) => 
      sum + (inv.total - (inv.amount_paid || 0)), 0
    );
    
    const overdueInvoices = invoices.filter((inv: any) => 
      inv.status === "overdue" || (inv.due_date < today && ["sent", "partial"].includes(inv.status))
    );
    const overdueReceivables = overdueInvoices.reduce((sum: number, inv: any) => 
      sum + (inv.total - (inv.amount_paid || 0)), 0
    );

    const totalPayables = bills.reduce((sum: number, bill: any) => 
      sum + (bill.total - (bill.amount_paid || 0)), 0
    );

    const recentRevenue = payments.reduce((sum: number, p: any) => sum + p.amount, 0);
    const recentExpensesTotal = expenses.reduce((sum: number, e: any) => sum + e.amount, 0);

    // Calculate today's POS sales
    const todayStart = new Date().toISOString().split('T')[0];
    const todayPOSSales = posTransactions
      .filter((t: any) => t.created_at.startsWith(todayStart) && t.payment_status === 'completed')
      .reduce((sum: number, t: any) => sum + (t.total || 0), 0);

    // Calculate total asset value
    const totalAssetValue = fixedAssets.reduce((sum: number, a: any) => sum + (a.current_value || 0), 0);

    // Store branches and admin context for prompt building
    const contextData = {
      organization: orgResult.data,
      bankAccounts,
      recentInvoices: invoices,
      recentExpenses: expenses,
      recentPayments: payments,
      pendingBills: bills,
      contacts: contactsResult.data || [],
      products,
      lowStockProducts,
      employees,
      leaveRequests,
      projects,
      projectTasks,
      crmLeads,
      fixedAssets,
      posTransactions,
      estimates,
      salesOrders,
      creditNotes,
      purchaseOrders,
      accounts,
      summary: {
        totalBankBalance,
        totalReceivables,
        totalPayables,
        overdueReceivables,
        recentRevenue,
        recentExpenses: recentExpensesTotal,
        totalProducts: products.length,
        lowStockCount: lowStockProducts.length,
        totalEmployees: employees.length,
        pendingLeaveRequests: leaveRequests.length,
        activeProjects: projects.length,
        openLeads: crmLeads.length,
        totalAssetValue,
        todayPOSSales,
      },
      // Extra data for branch-aware prompts
      _branches: branches,
      _isAdmin: isAdmin,
      _branchIds: branchIds,
      _currentBranchId: branchId,
      _businessId: businessId || null,
      _businessName: businessResult?.data?.name || null,
    };

    return contextData as FinancialContext;
  } catch (error) {
    console.error("Error fetching financial context:", error);
    return null;
  }
}

// Build context string for AI with branch awareness
function buildContextPrompt(context: FinancialContext, currencyCtx: WorkspaceCurrencyContext): string {
  const { 
    organization, bankAccounts, recentInvoices, recentExpenses, pendingBills, summary,
    lowStockProducts, employees, leaveRequests, projects, projectTasks, crmLeads,
    fixedAssets, posTransactions, estimates, salesOrders, creditNotes, purchaseOrders, accounts
  } = context;
  
  // Extract branch context (stored as internal properties)
  const branches = (context as any)._branches || [];
  const isAdmin = (context as any)._isAdmin || false;
  const branchIds = (context as any)._branchIds || [];
  const currentBranchId = (context as any)._currentBranchId;
  const businessName = (context as any)._businessName;
  const businessId = (context as any)._businessId;
  
  // The workspace currency comes from the canonical resolver
  // (businesses.base_currency). There is no literal fallback anywhere on this
  // path: when it cannot be resolved the model is told it is unknown.
  const cur = currencyCtx.baseCurrency;

  const today = new Date().toLocaleDateString();
  const todayISO = new Date().toISOString().split('T')[0];

  let prompt = `\n\n---\n**COMPLETE SYSTEM DATA (as of ${today}):**\n\n`;

  prompt += buildCurrencyRulePrompt(currencyCtx);

  // Business context indicator
  if (businessId && businessName) {
    prompt += `**⚡ BUSINESS CONTEXT: Viewing data for "${businessName}" only. All data below is scoped to this specific business.**\n\n`;
  } else {
    prompt += `**⚡ BUSINESS CONTEXT: Viewing consolidated organization overview across ALL businesses.**\n\n`;
  }

  // Organization info
  if (organization) {
    prompt += `**Organization:** ${organization.name}\n`;
    prompt += `**Base Currency:** ${cur ?? 'NOT CONFIGURED'}${currencyCtx.mixed ? ` (mixed across businesses: ${currencyCtx.businessCurrencies.join(', ')})` : ''}\n`;
  }

  // Branch context indicator
  if (isAdmin && branches.length > 1) {
    prompt += `**Access Level:** Administrator (viewing all ${branches.length} branches)\n\n`;
  } else if (branchIds.length > 0) {
    const currentBranch = branches.find((b: any) => b.id === currentBranchId);
    prompt += `**Current Branch:** ${currentBranch?.name || 'Your Branch'}\n`;
    prompt += `**Access Level:** Branch-level access (${branchIds.length} branch${branchIds.length > 1 ? 'es' : ''})\n\n`;
  } else {
    prompt += `\n`;
  }

  // ===== BRANCH PERFORMANCE BREAKDOWN (Admin only with multiple branches) =====
  if (isAdmin && branches.length > 1 && posTransactions.length > 0) {
    prompt += `## 🏢 Branch Performance Summary\n\n`;
    
    // Group POS sales by branch
    const salesByBranch: Record<string, { today: number; week: number; count: number; name: string }> = {};
    
    branches.forEach((branch: any) => {
      salesByBranch[branch.id] = { today: 0, week: 0, count: 0, name: branch.name };
    });
    
    posTransactions
      .filter((t: any) => t.payment_status === 'completed')
      .forEach((t: any) => {
        const branchId = t.register?.branch_id;
        if (branchId && salesByBranch[branchId]) {
          salesByBranch[branchId].week += t.total || 0;
          salesByBranch[branchId].count += 1;
          if (t.created_at.startsWith(todayISO)) {
            salesByBranch[branchId].today += t.total || 0;
          }
        }
      });
    
    prompt += `| Branch | Today's Sales | 7-Day Sales | Transactions | Avg Ticket |\n`;
    prompt += `|--------|---------------|-------------|--------------|------------|\n`;
    
    let totalToday = 0;
    let totalWeek = 0;
    let totalCount = 0;
    
    Object.entries(salesByBranch)
      .filter(([_, data]) => data.count > 0)
      .sort((a, b) => b[1].week - a[1].week)
      .forEach(([_, data]) => {
        const avgTicket = data.count > 0 ? data.week / data.count : 0;
        prompt += `| ${data.name} | ${formatCurrency(data.today, cur)} | ${formatCurrency(data.week, cur)} | ${data.count} | ${formatCurrency(avgTicket, cur)} |\n`;
        totalToday += data.today;
        totalWeek += data.week;
        totalCount += data.count;
      });
    
    const totalAvg = totalCount > 0 ? totalWeek / totalCount : 0;
    prompt += `| **TOTAL** | **${formatCurrency(totalToday, cur)}** | **${formatCurrency(totalWeek, cur)}** | **${totalCount}** | **${formatCurrency(totalAvg, cur)}** |\n\n`;
  }

  // ===== FINANCIAL SUMMARY =====
  prompt += `## 💰 Financial Summary\n`;
  prompt += `- **Total Bank Balance:** ${formatCurrency(summary.totalBankBalance, cur)}\n`;
  prompt += `- **Accounts Receivable (Money owed to you):** ${formatCurrency(summary.totalReceivables, cur)}\n`;
  prompt += `- **Overdue Receivables:** ${formatCurrency(summary.overdueReceivables, cur)}\n`;
  prompt += `- **Accounts Payable (Money you owe):** ${formatCurrency(summary.totalPayables, cur)}\n`;
  prompt += `- **Net Cash Flow (Last 30 days):** ${formatCurrency(summary.recentRevenue - summary.recentExpenses, cur)}\n`;
  prompt += `  - Revenue received: ${formatCurrency(summary.recentRevenue, cur)}\n`;
  prompt += `  - Expenses paid: ${formatCurrency(summary.recentExpenses, cur)}\n\n`;

  // Bank Accounts
  if (bankAccounts.length > 0) {
    prompt += `## 🏦 Bank Accounts\n`;
    bankAccounts.forEach((acc: any) => {
      prompt += `- **${acc.name}** (${acc.bank_name || 'Bank'}): ${formatRecordMoney(acc.current_balance, acc.currency, cur)} ${acc.is_primary ? '(Primary)' : ''}\n`;
    });
    prompt += `\n`;
  }

  // ===== POS SALES =====
  prompt += `## 🛒 POS Sales\n`;
  prompt += `- **Today's POS Sales:** ${formatCurrency(summary.todayPOSSales, cur)}\n`;
  if (posTransactions.length > 0) {
    const last7DaysSales = posTransactions
      .filter((t: any) => t.payment_status === 'completed')
      .reduce((sum: number, t: any) => sum + (t.total || 0), 0);
    const completedTxCount = posTransactions.filter((t: any) => t.payment_status === 'completed').length;
    prompt += `- **Last 7 Days Sales:** ${formatCurrency(last7DaysSales, cur)} (${completedTxCount} transactions)\n`;
    
    // Add context about data scope for non-admins
    if (!isAdmin && branchIds.length > 0) {
      prompt += `- *(Data filtered to your accessible branch${branchIds.length > 1 ? 'es' : ''})*\n`;
    }
  }
  prompt += `\n`;

  // ===== PRODUCTS & INVENTORY =====
  prompt += `## 📦 Products & Inventory\n`;
  prompt += `- **Total Active Products:** ${summary.totalProducts}\n`;
  prompt += `- **Low Stock Items:** ${summary.lowStockCount}\n`;
  if (lowStockProducts.length > 0) {
    prompt += `\n**Low Stock Alert:**\n`;
    lowStockProducts.slice(0, 10).forEach((p: any) => {
      prompt += `- ${p.name} (SKU: ${p.sku || 'N/A'}): ${p.quantity_on_hand} units (reorder at ${p.reorder_level || 0})\n`;
    });
    if (lowStockProducts.length > 10) {
      prompt += `  ...and ${lowStockProducts.length - 10} more items\n`;
    }
  }
  prompt += `\n`;

  // ===== OUTSTANDING INVOICES =====
  const unpaidInvoices = recentInvoices.filter((inv: any) => 
    ["sent", "overdue", "partial"].includes(inv.status)
  );
  if (unpaidInvoices.length > 0) {
    prompt += `## 📄 Outstanding Invoices (${unpaidInvoices.length} total)\n`;
    unpaidInvoices.slice(0, 10).forEach((inv: any) => {
      const outstanding = inv.total - (inv.amount_paid || 0);
      const contactName = inv.contact?.company || inv.contact?.name || 'Unknown';
      const isOverdue = inv.status === 'overdue' || new Date(inv.due_date) < new Date();
      prompt += `- **${inv.invoice_number}** - ${contactName}: ${formatCurrency(outstanding, cur)} due ${inv.due_date}${isOverdue ? ' ⚠️ OVERDUE' : ''}\n`;
    });
    if (unpaidInvoices.length > 10) {
      prompt += `  ...and ${unpaidInvoices.length - 10} more\n`;
    }
    prompt += `\n`;
  }

  // ===== PENDING BILLS =====
  if (pendingBills.length > 0) {
    prompt += `## 📑 Bills to Pay (${pendingBills.length} total)\n`;
    pendingBills.slice(0, 10).forEach((bill: any) => {
      const outstanding = bill.total - (bill.amount_paid || 0);
      const vendorName = bill.vendor?.company || bill.vendor?.name || 'Unknown';
      const isOverdue = bill.status === 'overdue' || new Date(bill.due_date) < new Date();
      prompt += `- **${bill.bill_number}** - ${vendorName}: ${formatCurrency(outstanding, cur)} due ${bill.due_date}${isOverdue ? ' ⚠️ OVERDUE' : ''}\n`;
    });
    if (pendingBills.length > 10) {
      prompt += `  ...and ${pendingBills.length - 10} more\n`;
    }
    prompt += `\n`;
  }

  // ===== ESTIMATES & SALES ORDERS =====
  if (estimates.length > 0 || salesOrders.length > 0) {
    prompt += `## 📋 Estimates & Sales Orders\n`;
    if (estimates.length > 0) {
      prompt += `**Pending Estimates (${estimates.length}):**\n`;
      estimates.slice(0, 5).forEach((est: any) => {
        const contactName = est.contact?.company || est.contact?.name || 'Unknown';
        prompt += `- ${est.estimate_number} - ${contactName}: ${formatCurrency(est.total, cur)} (valid until ${est.valid_until})\n`;
      });
    }
    if (salesOrders.length > 0) {
      prompt += `**Active Sales Orders (${salesOrders.length}):**\n`;
      salesOrders.slice(0, 5).forEach((so: any) => {
        const contactName = so.contact?.company || so.contact?.name || 'Unknown';
        prompt += `- ${so.order_number} - ${contactName}: ${formatCurrency(so.total, cur)} [${so.status}]\n`;
      });
    }
    prompt += `\n`;
  }

  // ===== PURCHASE ORDERS =====
  if (purchaseOrders.length > 0) {
    prompt += `## 🛍️ Purchase Orders (${purchaseOrders.length} pending)\n`;
    purchaseOrders.slice(0, 5).forEach((po: any) => {
      const vendorName = po.vendor?.company || po.vendor?.name || 'Unknown';
      prompt += `- ${po.po_number} - ${vendorName}: ${formatCurrency(po.total, cur)} (expected ${po.expected_delivery_date || 'TBD'})\n`;
    });
    prompt += `\n`;
  }

  // ===== CREDIT NOTES =====
  if (creditNotes.length > 0) {
    prompt += `## 📝 Credit Notes (${creditNotes.length} active)\n`;
    creditNotes.slice(0, 5).forEach((cn: any) => {
      const contactName = cn.contact?.company || cn.contact?.name || 'Unknown';
      const remaining = cn.total - (cn.amount_applied || 0);
      prompt += `- ${cn.credit_note_number} - ${contactName}: ${formatCurrency(remaining, cur)} remaining\n`;
    });
    prompt += `\n`;
  }

  // ===== EMPLOYEES & HR =====
  prompt += `## 👥 Employees & HR\n`;
  prompt += `- **Active Employees:** ${summary.totalEmployees}\n`;
  prompt += `- **Pending Leave Requests:** ${summary.pendingLeaveRequests}\n`;
  if (leaveRequests.length > 0) {
    prompt += `\n**Pending Leave Requests:**\n`;
    leaveRequests.slice(0, 5).forEach((lr: any) => {
      const empName = lr.employee ? `${lr.employee.first_name} ${lr.employee.last_name}` : 'Unknown';
      prompt += `- ${empName}: ${lr.leave_type} (${lr.start_date} to ${lr.end_date})\n`;
    });
  }
  prompt += `\n`;

  // ===== PROJECTS & TASKS =====
  prompt += `## 📊 Projects & Tasks\n`;
  prompt += `- **Active Projects:** ${summary.activeProjects}\n`;
  if (projects.length > 0) {
    prompt += `\n**Active Projects:**\n`;
    projects.slice(0, 5).forEach((p: any) => {
      const progress = p.progress || 0;
      prompt += `- **${p.name}** [${p.status}]: ${progress}% complete, budget ${formatCurrency(p.budget || 0, cur)}, deadline ${p.deadline || 'TBD'}\n`;
    });
  }
  if (projectTasks.length > 0) {
    prompt += `\n**Pending Tasks (${projectTasks.length}):**\n`;
    projectTasks.slice(0, 5).forEach((t: any) => {
      prompt += `- ${t.name} (${t.project?.name || 'No project'}): [${t.priority}] due ${t.due_date || 'TBD'}\n`;
    });
  }
  prompt += `\n`;

  // ===== CRM LEADS =====
  prompt += `## 🎯 CRM & Leads\n`;
  prompt += `- **Open Leads:** ${summary.openLeads}\n`;
  if (crmLeads.length > 0) {
    const pipelineValue = crmLeads.reduce((sum: number, l: any) => sum + ((l.expected_revenue || 0) * (l.probability || 0) / 100), 0);
    prompt += `- **Weighted Pipeline Value:** ${formatCurrency(pipelineValue, cur)}\n`;
    prompt += `\n**Top Leads:**\n`;
    crmLeads.slice(0, 5).forEach((l: any) => {
      prompt += `- **${l.name}** (${l.email || 'No email'}): ${formatCurrency(l.expected_revenue || 0, cur)} at ${l.probability || 0}% [${l.stage}]\n`;
    });
  }
  prompt += `\n`;

  // ===== FIXED ASSETS =====
  prompt += `## 🏢 Fixed Assets\n`;
  prompt += `- **Total Asset Value:** ${formatCurrency(summary.totalAssetValue, cur)}\n`;
  if (fixedAssets.length > 0) {
    prompt += `- **Active Assets:** ${fixedAssets.length}\n`;
    prompt += `\n**Top Assets:**\n`;
    fixedAssets.slice(0, 5).forEach((a: any) => {
      prompt += `- ${a.name} (${a.asset_number}): ${formatCurrency(a.current_value, cur)} (purchased ${formatCurrency(a.purchase_price, cur)})\n`;
    });
  }
  prompt += `\n`;

  // ===== EXPENSE SUMMARY =====
  if (recentExpenses.length > 0) {
    const expensesByCategory: Record<string, number> = {};
    recentExpenses.forEach((exp: any) => {
      const category = exp.category?.name || 'Uncategorized';
      expensesByCategory[category] = (expensesByCategory[category] || 0) + exp.amount;
    });
    
    prompt += `## 💸 Expenses by Category (Last 30 days)\n`;
    Object.entries(expensesByCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([category, amount]) => {
        prompt += `- **${category}:** ${formatCurrency(amount, cur)}\n`;
      });
    prompt += `\n`;
  }

  // ===== CHART OF ACCOUNTS SUMMARY =====
  if (accounts.length > 0) {
    const accountsByType: Record<string, number> = {};
    accounts.forEach((acc: any) => {
      const type = acc.account_type || 'Other';
      accountsByType[type] = (accountsByType[type] || 0) + (acc.current_balance || 0);
    });
    
    prompt += `## 📒 Account Balances by Type\n`;
    Object.entries(accountsByType)
      .forEach(([type, balance]) => {
        prompt += `- **${type}:** ${formatCurrency(balance, cur)}\n`;
      });
    prompt += `\n`;
  }

  prompt += `---\n\nUse the above real-time data to answer questions. Be specific with numbers. Do not ask the user for information that is already provided above.\n`;
  
  return prompt;
}

function formatCurrency(amount: number, currency: string | null): string {
  // CRITICAL: We render the ISO currency CODE explicitly (e.g. "KES 1,234.50")
  // rather than relying on locale symbols. This stops the model from
  // hallucinating "$" for non-USD workspaces — every value the model sees
  // already carries the correct code as a literal token, so it has no
  // freedom to substitute a different symbol when echoing numbers back.
  // No literal fallback: an unresolved workspace currency is reported as such
  // rather than silently relabelled (see _shared/workspaceCurrency.ts).
  return formatMoney(amount, currency);
}

const systemPrompts: Record<string, string> = {
  categorize_expense: `You are an expert accountant AI assistant specializing in expense categorization.
Analyze the expense description and suggest the most appropriate category from these options:
- Office Supplies
- Travel & Transportation
- Meals & Entertainment
- Professional Services
- Software & Subscriptions
- Utilities
- Marketing & Advertising
- Equipment & Hardware
- Insurance
- Rent & Facilities
- Bank & Finance Charges
- Other

Return your response as JSON with structure:
{ "category": "Category Name", "confidence": 0.95, "reasoning": "Brief explanation" }`,

  analyze_invoice: `You are an expert accountant AI assistant that analyzes invoices.
Extract key information and provide insights about the invoice.
Look for:
- Payment terms and due date urgency
- Unusual amounts or discrepancies
- Potential duplicate invoices
- Tax calculation accuracy
- Suggestions for follow-up

Return your response as JSON with structure:
{
  "summary": "Brief invoice summary",
  "urgency": "low|medium|high",
  "insights": ["insight 1", "insight 2"],
  "warnings": ["warning 1"],
  "recommendations": ["recommendation 1"]
}`,

  financial_insights: `You are a senior financial analyst AI assistant with direct access to the organization's financial data.
Analyze the provided real-time financial data and generate actionable insights.

IMPORTANT: Always use the organization's base currency as shown in the data context. Do NOT default to USD unless that is the configured base currency. All monetary values in the data are already in the organization's base currency.

Your analysis should include:
- Cash flow status (positive/negative, burn rate)
- Receivables health (overdue amounts, collection recommendations)
- Payables management (upcoming due dates, cash requirements)
- Profitability indicators
- Specific, actionable recommendations

Format your response using clear markdown sections. Be specific with numbers from the data provided. Use the same currency symbols as shown in the data.`,

  suggest_actions: `You are an intelligent accounting assistant that helps users be more productive.
Based on the current financial context, suggest relevant actions the user might want to take.

Return JSON with structure:
{
  "suggestions": [
    {
      "title": "Action title",
      "description": "Why this is relevant",
      "priority": "high|medium|low",
      "actionType": "create_invoice|follow_up|review|reconcile|other"
    }
  ]
}`,

  email_assist: `You are an expert business email writer. Your task is to improve or rewrite email messages for business documents like invoices, estimates, and quotes.

Rules:
- Maintain the same core information and intent
- Keep the message professional and appropriate for business communication
- Output ONLY the improved email text, nothing else
- Do not include explanations or commentary
- Preserve any specific amounts, dates, or reference numbers mentioned`,

  match_transactions: `You are an expert bank reconciliation AI assistant. Your task is to analyze bank transactions and match them with invoices, bills, or expenses.

For each bank transaction, analyze:
1. Transaction description and reference
2. Amount (positive = credit/income, negative = debit/expense)
3. Transaction date

Compare against the provided list of pending invoices (for credits) and bills/expenses (for debits).

Matching criteria:
- Amount match (exact or close within 5%)
- Description/reference similarity
- Date proximity (transaction within reasonable time of invoice/bill date)

Return your response as JSON with structure:
{
  "matches": [
    {
      "transaction_id": "uuid",
      "matched_type": "invoice" | "bill" | "expense" | null,
      "matched_entity_id": "uuid" | null,
      "matched_entity_reference": "INV-001" | null,
      "confidence": 0.95,
      "reasoning": "Brief explanation of why this match was chosen"
    }
  ]
}

If no confident match is found (confidence < 0.7), set matched_type and matched_entity_id to null.
Be conservative - only suggest matches with high confidence.`,

  chat: `You are AccrualFlow AI, an expert business management assistant with FULL ACCESS to the organization's complete real-time data.

IMPORTANT: You have direct access to ALL system data provided below. Use actual numbers and specifics. Do NOT ask users for information that is already in the data context.
IMPORTANT: Always use the organization's base currency as indicated in the data context for all monetary values. Never assume USD unless that is the configured base currency.
CRITICAL CURRENCY RULE: Every monetary value in the data context is prefixed with the workspace's ISO currency code (e.g. "KES 1,200.00"). You MUST reproduce that exact ISO code in your responses. NEVER substitute "$", "USD", or any other symbol/code. If the workspace currency is KES, write "KES 0.00" — not "$0.00". Violating this rule is a critical error.

**YOUR KNOWLEDGE INCLUDES:**

📊 **Financial Data:**
- Bank accounts, balances, and cash flow
- Invoices (sent, overdue, paid), payments received
- Bills to pay, expenses by category
- Credit notes and their applications

🛒 **Sales & POS:**
- Point of sale transactions and daily sales
- Sales orders, estimates, proforma invoices
- Delivery notes and customer orders

📦 **Products & Inventory:**
- Product catalog with pricing
- Stock levels and low stock alerts
- Warehouses and inventory locations

👥 **HR & Employees:**
- Employee directory and departments
- Leave requests (pending, approved)
- Timesheets and attendance

📊 **Projects & CRM:**
- Active projects with progress and deadlines
- Project tasks and assignments
- CRM leads and pipeline value
- Customer activities and follow-ups

🏢 **Fixed Assets:**
- Asset register with valuations
- Depreciation and maintenance records

📒 **Accounting:**
- Chart of accounts and balances
- Journal entries and reconciliation

🛠️ **Studio (Customization Platform) — COMPLETE GUIDE:**

Studio is the system's customization engine (like Odoo Studio). It has 6 modules accessible via the top navigation at /studio:

**1. Fields (/studio — default landing page)**
Create and manage custom fields for any entity type. This is where you extend the data model.

*Supported Entity Types:* Contact, Product, Invoice, Estimate, Sales Order, Purchase Order, Project, CRM Lead, Expense, Bill

*Supported Field Types:*
- **Text** — Single-line text input
- **Number** — Numeric value (integers or decimals)
- **Date** — Date picker (date only)
- **DateTime** — Date and time picker
- **Boolean** — Toggle switch (yes/no)
- **Select** — Dropdown with predefined options (define value/label pairs when creating)
- **MultiSelect** — Multiple selection from predefined options
- **Related** — Link to another entity record
- **Computed** — Calculated field based on formulas
- **HTML** — Rich text / HTML content
- **File** — File attachment

*Field Properties (toggleable per field):*
- **Required** — Must be filled before saving
- **Visible** — Show/hide on forms
- **Searchable** — Include in search results
- **Filterable** — Available as a filter option in list views

*How to create a custom field:*
1. Go to Studio → Fields (the default tab)
2. Select the entity type from the left sidebar (desktop) or dropdown (mobile)
3. Click "Add Custom Field"
4. Enter: Field Label, Field Type, Placeholder (optional), Help Text (optional)
5. For Select/MultiSelect types: add option value-label pairs
6. Toggle Required, Searchable, Filterable as needed
7. Click Save

*Document Field Placement (for document entity types only):*
For Invoice, Estimate, Sales Order, Purchase Order, Bill, and Expense entities, a "Document Field Placement" section appears below the field list. This lets you drag custom fields into specific sections of printed documents:
- **Header** — Near document number and date
- **Customer Details** — Beside Bill To / Ship To
- **After Items** — Below the line items table
- **Notes Section** — With notes and payment info
- **Footer** — At the bottom of the document
- **Additional Info** — Separate info block (default placement)

To place a field: drag it from one section and drop it into another. Click the X to remove it from a section (moves back to Additional Info).

**2. Automations (/studio/automations)**
Create event-driven or scheduled workflows that run automatically.

*Trigger Types:*
- **On Create** — Fires when a new record is created
- **On Update** — Fires when a record is modified
- **On Delete** — Fires when a record is deleted
- **Time Based** — Fires on a schedule (interval, cron, specific time)
- **Field Change** — Fires when a specific field value changes
- **Webhook** — Fires when an external webhook is received
- **Manual** — User-triggered (run on demand)

*Action Types (steps that execute when triggered):*
- **Update Record** — Modify fields on the triggering record or related records
- **Create Record** — Create a new record in any entity
- **Send Email** — Send an email notification
- **Send Notification** — Send an in-app notification
- **Webhook Call** — Make an HTTP request to an external URL
- **Create Activity** — Schedule a follow-up activity
- **Add Tag** — Apply a tag to the record
- **Run Code** — Execute custom logic

*How to create an automation:*
1. Go to Studio → Automations
2. Click "Create Automation" (or "Templates" to start from a pre-built template)
3. Enter: Name, Description, Trigger type, Target Model (entity type)
4. Click "Create & Configure" — this opens the Steps editor
5. Add action steps: click "Add Step", choose action type, configure the action
6. Each step runs in order; you can add multiple steps
7. Toggle the automation on/off with the switch on the card
8. Use "Copy" to duplicate an automation

*Automation cards show:* trigger type badge, target model, active/inactive status, description. Active and inactive automations are grouped separately.

**3. Views (/studio/views)**
Create and manage saved views (list, kanban, pivot, chart, calendar, gantt) for any entity.

*View Types:*
- **List** — Traditional table/grid view with sortable columns
- **Kanban** — Card-based board grouped by a field (like a pipeline)
- **Pivot** — Pivot table for data analysis and aggregation
- **Chart** — Visual charts (bar, line, pie) for data visualization
- **Calendar** — Calendar-based view for date-driven records
- **Gantt** — Timeline/Gantt chart for project planning

*View Properties:*
- **Name** — Display name for the view
- **Shared** — Toggle to share with team or keep private
- **Default** — Set as the default view for this entity type

*How to create a view:*
1. Go to Studio → Views
2. Select the entity type from the dropdown
3. Click "New View"
4. Enter view name, select view type, toggle Shared/Default
5. Click "Create View"
6. To set as default later: use the ⋮ menu → "Set as Default"

**4. Forms (/studio/forms)**
Design custom form layouts with tabs, field groups, and column arrangements.

*Layout Structure:*
- **Tabs** — Top-level sections (e.g., "General", "Billing", "Notes")
- **Groups** — Within each tab, groups organize fields (e.g., "Basic Information", "Address")
- **Columns** — Each group can have 1, 2, 3, or 4 columns for field arrangement
- **Fields** — Individual fields placed within groups

*Field Width Overrides:* quarter, third, half, two-thirds, three-quarters, full

*Field Overrides per Layout:*
- Custom label (different from the field's default label)
- Width override
- Hidden (hide a field in this layout only)
- Read-only (prevent editing in this layout)

*Groups can be:* collapsible (with toggle) and optionally default-collapsed

*How to create a form layout:*
1. Go to Studio → Forms
2. Select the entity type from the dropdown
3. Click "New Layout"
4. Enter layout name, toggle "Set as Default"
5. Click "Create Layout" — creates with a default "General" tab and "Basic Information" group
6. Expand the layout to see the tab/group preview
7. Edit or delete layouts via the ⋮ menu

**5. Reports (/studio/reports)**
Design custom document templates using HTML/CSS with template variables.

*Report Types:* Invoice, Estimate, Bill, Credit Note, Sales Order, Purchase Order, Receipt, Delivery Note

*Template Editor has 4 tabs:*
- **HTML** — Main body template with Handlebars-style variables
- **CSS** — Custom styles for the template
- **Header** — Repeating header content (appears on every page)
- **Footer** — Repeating footer content (appears on every page)

*Available Template Variables (insert from the left panel):*
- **Company:** {{company_name}}, {{company_address}}, {{company_phone}}, {{company_email}}
- **Document:** {{document_title}}, {{document_number}}, {{document_date}}, {{due_date}}
- **Customer:** {{customer_name}}, {{customer_address}}, {{customer_email}}
- **Items:** {{#each items}}...{{/each}} loop with {{description}}, {{quantity}}, {{unit_price}}, {{line_total}}
- **Totals:** {{subtotal}}, {{tax_amount}}, {{total}}

*Page Settings (right panel):*
- Page Size: A4, Letter, Legal, A5
- Orientation: Portrait, Landscape
- Margins: Top, Right, Bottom, Left (in mm)

*How to create a report template:*
1. Go to Studio → Reports
2. Click "New Template"
3. Enter template name and select report type
4. Click in the template list to open the editor
5. Write HTML in the body tab, insert variables from the Fields panel on the left
6. Add CSS for styling, set page size/orientation/margins in the right panel
7. Click "Preview" to see the rendered output
8. Click "Save Template"
9. Set as default via the ⋮ menu; duplicate templates for variations

**6. Scheduling (/studio/scheduling)**
Automate report generation and delivery via email on recurring schedules.

*Available Report Types for Scheduling:*
Financial: Balance Sheet, Income Statement, Cash Flow Statement, Trial Balance
Sales: Sales Summary, Invoice Aging, Customer Analysis
Operations: Stock Report, Tax Report

*Schedule Frequencies:*
- Daily — runs every day at specified time
- Weekly — runs on a specific day of the week at specified time
- Monthly — runs on a specific day of the month (1-28) at specified time
- Quarterly — runs quarterly at specified time
- Test frequencies: Every 1 min, Every 5 min, Every 15 min (for testing)

*Report Formats:* PDF, CSV, Excel
*Include Charts:* Toggle to include visual charts in the report

*Date Ranges:* Last 7 Days, Last 30 Days, This Month, Last Month, This Quarter, Last Quarter, This Year, Last Year

*How to create a scheduled report:*
1. Go to Studio → Scheduling
2. Click "New Schedule"
3. Fill in: Name, Report Type, Schedule (frequency + day/time), Format, Date Range
4. Add recipient email addresses (comma-separated)
5. Toggle "Include Charts" if desired
6. Click Save
7. Use "Send Now" to trigger an immediate send for testing
8. View delivery history in the "History" tab
9. Toggle active/inactive with the switch

*Dashboard Stats:* Total Schedules, Active count, Sent This Month, Failed This Month

**HOW TO RESPOND:**
- Use specific numbers from the data provided
- Format responses with markdown for clarity
- Be concise but thorough
- Proactively offer insights when relevant
- Suggest actions based on the data (e.g., follow up on overdue invoices)
- When on Studio pages, provide step-by-step guidance with exact UI element references
- For Studio questions, include the specific field types, trigger types, view types etc. from the lists above

You are friendly, professional, and deeply knowledgeable about business operations, accounting, and system customization.`,

  document_text_notes: `You are an expert business writer specializing in professional document notes for invoices, estimates, quotes, and sales orders.

Your task is to generate or improve customer-facing notes that appear on business documents.

Guidelines for notes:
- Keep it concise (2-4 sentences maximum)
- Be warm and professional
- Thank the customer when appropriate
- Include relevant delivery or service information if context is provided
- Avoid legal jargon - that belongs in terms & conditions
- Personalize with customer name if provided

Output ONLY the note text, no explanations or formatting instructions.`,

  document_text_terms: `You are an expert business writer specializing in professional terms and conditions for business documents.

Your task is to generate or improve terms & conditions for invoices, estimates, quotes, and sales orders.

Guidelines for terms:
- Be clear and professional
- Include payment terms if the document type requires it
- Keep it reasonably concise (3-6 points or short paragraphs)
- Cover key areas: payment terms, validity (for quotes), warranties/guarantees if applicable
- Use professional but accessible language
- Use plain numbered lines (1. 2. 3.) separated by line breaks for structure
- Do NOT use markdown formatting: no asterisks, no hashes, no bold, no bullet dashes, no headers

Document-specific guidance:
- Estimates/Quotes: Include validity period, scope limitations, price change conditions
- Invoices: Payment due date, late payment penalties, accepted payment methods
- Sales Orders: Delivery terms, returns policy, order cancellation
- Proforma: Validity, payment before delivery, subject to availability

Output ONLY the terms text as clean plain text. No markdown, no explanations, no headers like "Terms & Conditions:".`
};


// Get available providers and keys from database
async function getAvailableProviders(supabaseClient: any): Promise<{ providers: ProviderConfig[]; keys: ApiKeyConfig[] }> {
  const { data: providers } = await supabaseClient
    .from("ai_providers")
    .select("id, provider_code, base_url, default_model, priority")
    .eq("is_enabled", true)
    .order("priority");

  const { data: keys } = await supabaseClient
    .from("ai_api_keys")
    .select("id, provider_id, vault_secret_id, priority, last_rate_limited_at")
    .eq("is_enabled", true)
    .order("priority");

  return { providers: providers || [], keys: keys || [] };
}

// Get AI settings
async function getAISettings(supabaseClient: any): Promise<Record<string, string>> {
  const { data } = await supabaseClient
    .from("ai_settings")
    .select("setting_key, setting_value");

  const settings: Record<string, string> = {};
  (data || []).forEach((s: any) => {
    settings[s.setting_key] = s.setting_value;
  });
  return settings;
}

// Log usage
async function logUsage(
  supabaseClient: any,
  apiKeyId: string | null,
  providerCode: string,
  requestType: string,
  modelUsed: string | null,
  wasRateLimited: boolean,
  wasFallback: boolean,
  errorMessage: string | null,
  responseTimeMs: number | null
) {
  try {
    await supabaseClient.from("ai_usage_logs").insert({
      api_key_id: apiKeyId,
      provider_code: providerCode,
      request_type: requestType,
      model_used: modelUsed,
      was_rate_limited: wasRateLimited,
      was_fallback: wasFallback,
      error_message: errorMessage,
      response_time_ms: responseTimeMs,
    });
  } catch (e) {
    console.error("Failed to log usage:", e);
  }
}

// Check if key is in cooldown
function isKeyInCooldown(key: ApiKeyConfig, cooldownSeconds: number): boolean {
  if (!key.last_rate_limited_at) return false;
  const lastRateLimited = new Date(key.last_rate_limited_at).getTime();
  const cooldownMs = cooldownSeconds * 1000;
  return Date.now() - lastRateLimited < cooldownMs;
}

// Make AI request with fallback support
async function makeAIRequest(
  supabaseClient: any,
  aiMessages: Array<Record<string, any>>,
  requestType: string,
  isStreaming: boolean,
  settings: Record<string, string>,
  tools?: ToolSpec[]
): Promise<Response> {
  const { providers, keys } = await getAvailableProviders(supabaseClient);
  const fallbackEnabled = settings.fallback_enabled === "true";
  const cooldownSeconds = parseInt(settings.rate_limit_cooldown_seconds || "60");
  const maxAttempts = parseInt(settings.max_fallback_attempts || "3");
  const temperature = parseFloat(settings.default_temperature || "0.7");

  // Build ordered list of provider/key combinations
  const attempts: Array<{ provider: ProviderConfig; key: ApiKeyConfig | null; useLovable: boolean }> = [];

  // First, add Lovable (built-in) if enabled
  const lovableProvider = providers.find(p => p.provider_code === "lovable");
  if (lovableProvider) {
    attempts.push({ provider: lovableProvider, key: null, useLovable: true });
  }

  // Then add other providers with their keys
  for (const provider of providers.filter(p => p.provider_code !== "lovable")) {
    const providerKeys = keys
      .filter(k => k.provider_id === provider.id)
      .filter(k => !isKeyInCooldown(k, cooldownSeconds))
      .sort((a, b) => a.priority - b.priority);

    for (const key of providerKeys) {
      attempts.push({ provider, key, useLovable: false });
    }
  }

  // ── Hard fallback: if no provider rows exist (fresh tenant) but the
  //   LOVABLE_API_KEY secret is configured, synthesize a virtual lovable
  //   attempt so the assistant works out of the box on every workspace.
  const hasLovable = attempts.some(a => a.useLovable);
  if (!hasLovable && Deno.env.get("LOVABLE_API_KEY")) {
    attempts.push({
      provider: {
        id: "__virtual_lovable__",
        provider_code: "lovable",
        base_url: "https://ai.gateway.lovable.dev/v1/chat/completions",
        default_model: "google/gemini-3-flash-preview",
      } as any,
      key: null,
      useLovable: true,
    });
  }

  if (attempts.length === 0) {
    return new Response(
      JSON.stringify({ error: "No AI providers available. Please configure API keys in admin settings." }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let lastError: string | null = null;
  let attemptCount = 0;

  for (const attempt of attempts) {
    if (attemptCount >= maxAttempts && !fallbackEnabled) break;
    attemptCount++;

    const startTime = Date.now();
    const isFallback = attemptCount > 1;

    try {
      let apiKey: string;
      let baseUrl: string;
      let model: string;

      if (attempt.useLovable) {
        apiKey = Deno.env.get("LOVABLE_API_KEY") || "";
        if (!apiKey) {
          console.log("Lovable API key not configured, skipping...");
          continue;
        }
        baseUrl = attempt.provider.base_url;
        model = attempt.provider.default_model || "google/gemini-3-flash-preview";
      } else {
        if (!attempt.key) continue;
        // Resolve plaintext from Supabase Vault via SECURITY DEFINER RPC.
        // Keys are never stored as plaintext in the ai_api_keys table.
        const { data: secret, error: secretErr } = await supabaseClient.rpc(
          "get_ai_api_key_secret",
          { p_id: attempt.key.id },
        );
        if (secretErr || !secret) {
          console.log(`Could not resolve vault secret for key ${attempt.key.id}, skipping...`);
          continue;
        }
        apiKey = secret as string;
        baseUrl = attempt.provider.base_url;
        model = attempt.provider.default_model || "gpt-4o";
      }

      console.log(`Attempting ${attempt.provider.provider_code} with model ${model}...`);

      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: aiMessages,
          stream: isStreaming,
          temperature: requestType === "chat" ? temperature : 0.3,
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
        }),
      });

      const responseTime = Date.now() - startTime;

      if (response.ok) {
        await logUsage(
          supabaseClient,
          attempt.key?.id || null,
          attempt.provider.provider_code,
          requestType,
          model,
          false,
          isFallback,
          null,
          responseTime
        );

        if (isStreaming) {
          return new Response(response.body, {
            headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
          });
        }

        return new Response(response.body, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (response.status === 429) {
        console.log(`Rate limited by ${attempt.provider.provider_code}, trying fallback...`);
        await logUsage(supabaseClient, attempt.key?.id || null, attempt.provider.provider_code, requestType, model, true, isFallback, "Rate limited", responseTime);
        lastError = "Rate limit exceeded";
        if (!fallbackEnabled) break;
        continue;
      }

      if (response.status === 402) {
        lastError = "AI credits exhausted";
        await logUsage(supabaseClient, attempt.key?.id || null, attempt.provider.provider_code, requestType, model, false, isFallback, "Credits exhausted", responseTime);
        if (!fallbackEnabled) break;
        continue;
      }

      const errorText = await response.text();
      console.error(`Error from ${attempt.provider.provider_code}:`, response.status, errorText);
      lastError = `Provider error: ${response.status}`;
      await logUsage(supabaseClient, attempt.key?.id || null, attempt.provider.provider_code, requestType, model, false, isFallback, errorText.substring(0, 500), responseTime);
      if (!fallbackEnabled) break;

    } catch (e) {
      console.error(`Exception with ${attempt.provider.provider_code}:`, e);
      lastError = e instanceof Error ? e.message : "Unknown error";
      if (!fallbackEnabled) break;
    }
  }

  return new Response(
    JSON.stringify({ error: lastError || "AI service temporarily unavailable. Please try again later.", fallback_exhausted: true }),
    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

/**
 * Resolve the model's data questions BEFORE the answer is streamed.
 *
 * The assistant runs on the service-role key, so every read is scoped and
 * column-allowlisted inside `dataTools.ts` — the model never composes SQL or a
 * PostgREST filter string itself, and no tool can write. We run the tool
 * rounds non-streaming and then hand the enriched transcript (including every
 * tool result) to the normal streaming call, so the user sees a single answer
 * that is grounded in rows actually read from their tenant.
 */
async function runDataToolLoop(
  supabaseClient: any,
  aiMessages: Array<Record<string, any>>,
  settings: Record<string, string>,
  scope: ToolScope,
  currencySummary: Record<string, unknown>,
  maxRounds = 4,
): Promise<Array<Record<string, any>>> {
  const tools = buildDataToolSpecs();
  let working = [...aiMessages];

  for (let round = 0; round < maxRounds; round++) {
    let payload: any;
    try {
      const res = await makeAIRequest(supabaseClient, working, "chat", false, settings, tools);
      if (!res.ok) return working; // provider unavailable: answer from the snapshot
      payload = await res.json();
    } catch (e) {
      console.error("Tool loop request failed", e);
      return working;
    }

    const message = payload?.choices?.[0]?.message;
    const toolCalls = message?.tool_calls;
    if (!message || !Array.isArray(toolCalls) || toolCalls.length === 0) return working;

    working.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      let args: Record<string, any> = {};
      try {
        args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      let result: Record<string, unknown>;
      try {
        result = await executeDataTool(
          supabaseClient,
          call?.function?.name ?? "",
          args,
          scope,
          currencySummary,
        );
      } catch (e) {
        console.error("Tool execution failed", call?.function?.name, e);
        result = { error: e instanceof Error ? e.message : "Tool execution failed" };
      }
      working.push({
        role: "tool",
        tool_call_id: call.id,
        name: call?.function?.name ?? "unknown",
        content: JSON.stringify(result).slice(0, 24000),
      });
    }
  }

  return working;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // NOTE: `userRole` and `accessibleBranchIds` from the request body are
    // IGNORED. They are derived server-side below from the caller's JWT to
    // prevent privilege escalation (a non-admin could otherwise claim
    // admin to bypass branch-scoped data filtering).
    const { type, data, messages, organizationId, businessId, branchId, currentPage }: AIRequest = await req.json();
    let userRole: string | undefined;
    let accessibleBranchIds: string[] | undefined;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);

    // ─── Auth gate: verify caller identity and org membership ───
    // The service-role client below bypasses RLS, so we MUST establish
    // the caller's identity and confirm they belong to organizationId
    // before fetching any tenant data. Cron / server-to-server callers
    // may present the service-role key directly.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!bearer) {
      return new Response(
        JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (bearer !== supabaseServiceKey) {
      const { data: userData, error: userErr } = await supabaseClient.auth.getUser(bearer);
      if (userErr || !userData?.user) {
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (organizationId) {
        const { data: roleRow } = await supabaseClient
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("organization_id", organizationId)
          .eq("is_active", true)
          .maybeSingle();
        if (!roleRow) {
          return new Response(
            JSON.stringify({ error: "forbidden: not a member of this organization" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        // Trust ONLY the DB-derived role + branch assignments.
        userRole = (roleRow as { role?: string }).role;
        const { data: branchRows } = await supabaseClient
          .from("user_branch_assignments")
          .select("branch_id")
          .eq("user_id", userData.user.id)
          .eq("organization_id", organizationId)
          .eq("can_view", true);
        accessibleBranchIds = (branchRows ?? [])
          .map((r: { branch_id: string | null }) => r.branch_id)
          .filter((id): id is string => !!id);
      }
    }



    // ─── Subscription entitlement check ───
    // The in-app help/chat surface (and its inline suggestions) is the
    // escape hatch users need when stuck — it must work for every tenant
    // out of the box. Only the *billable* AI features are entitlement-gated.
    // Platform admins can still kill the chat globally via the
    // `chat_enabled` setting checked below.
    const ENTITLEMENT_FREE_TYPES = new Set(["chat", "suggest_actions"]);
    if (organizationId && !ENTITLEMENT_FREE_TYPES.has(type)) {
      const { checkEntitlement, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
      const entitlementResult = await checkEntitlement(supabaseClient, organizationId, "ai_assistant");
      if (!entitlementResult.allowed) {
        return entitlementDeniedResponse(entitlementResult, corsHeaders);
      }
    }

    const settings = await getAISettings(supabaseClient);

    if (settings.ai_enabled === "false") {
      return new Response(
        JSON.stringify({ error: "AI features are currently disabled by the administrator." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const featureMap: Record<string, string> = {
      categorize_expense: "expense_categorization_enabled",
      analyze_invoice: "invoice_analysis_enabled",
      financial_insights: "financial_insights_enabled",
      chat: "chat_enabled",
      suggest_actions: "financial_insights_enabled",
      email_assist: "chat_enabled",
      match_transactions: "expense_categorization_enabled",
      document_text: "chat_enabled",
    };

    const featureKey = featureMap[type];
    if (featureKey && settings[featureKey] === "false") {
      return new Response(
        JSON.stringify({ error: `This AI feature (${type}) is currently disabled.` }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve the workspace currency for EVERY request type — categorisation,
    // invoice analysis, email drafting and document text all used to run with
    // zero currency context and defaulted to USD.
    const currencyCtx: WorkspaceCurrencyContext = organizationId
      ? await resolveWorkspaceCurrency(supabaseClient, organizationId, businessId)
      : UNRESOLVED_CURRENCY_CONTEXT;

    // Fetch financial context if organization ID is provided - now with branch awareness
    let financialContext: FinancialContext | null = null;
    if (organizationId && (type === "chat" || type === "financial_insights" || type === "suggest_actions")) {
      financialContext = await getFinancialContext(
        supabaseClient, 
        organizationId,
        businessId,
        branchId,
        userRole,
        accessibleBranchIds
      );
    }

    let systemPrompt = systemPrompts[type] || systemPrompts.chat;

    
    // Handle document_text request type with specific prompts
    if (type === "document_text" && data) {
      const fieldType = data.fieldType || "notes";
      systemPrompt = systemPrompts[`document_text_${fieldType}`] || systemPrompts.document_text_notes;
    }
    
    // The currency rule is universal: it is prepended to every request type
    // before any task-specific context.
    systemPrompt += "\n\n" + buildCurrencyRulePrompt(currencyCtx);

    // Append page context hint
    if (currentPage && type === "chat") {
      systemPrompt += `\n\nThe user is currently on the "${currentPage}" page. Prioritize information relevant to this context when answering.`;
    }

    // Append financial context to system prompt
    if (financialContext) {
      systemPrompt += buildContextPrompt(financialContext, currencyCtx);
    }

    // ── Inject route catalog + action-block protocol + payroll diagnostics
    //    so the assistant can emit verified, actionable buttons.
    if (type === "chat") {
      systemPrompt += "\n\n" + ROUTE_CATALOG_PROMPT;
      systemPrompt += "\n\n" + ACTION_BLOCK_PROTOCOL_PROMPT;
      systemPrompt += "\n\n" + DATA_TOOLS_PROMPT;
      if (organizationId) {
        const diag = await buildPayrollDiagnostics(supabaseClient, organizationId, businessId);
        if (diag) systemPrompt += "\n\n" + diag;
      }
    }
    
    let aiMessages: Array<Record<string, any>> = [
      { role: "system", content: systemPrompt }
    ];

    if (type === "chat" && messages) {
      aiMessages = [...aiMessages, ...messages];
    } else if (type === "email_assist" && data?.prompt) {
      aiMessages.push({ 
        role: "user", 
        content: data.prompt 
      });
    } else if (type === "document_text" && data) {
      // Build document context prompt
      const docType = data.documentType || "document";
      const action = data.action || "generate";
      const fieldType = data.fieldType || "notes";
      
      let userPrompt = "";
      
      if (action === "generate") {
        userPrompt = `Generate professional ${fieldType} for a ${docType.replace("_", " ")}.`;
      } else if (action === "improve") {
        userPrompt = `Improve the following ${fieldType} text while keeping the same meaning:\n\n"${data.currentText}"`;
      } else if (action === "professional") {
        userPrompt = `Rewrite the following ${fieldType} to be more professional and polished:\n\n"${data.currentText}"`;
      }
      
      // Add context
      const contextParts: string[] = [];
      if (data.customerName) contextParts.push(`Customer: ${data.customerName}`);
      if (data.documentNumber) contextParts.push(`Document: ${data.documentNumber}`);
      if (data.lineItemsSummary) contextParts.push(`Items: ${data.lineItemsSummary}`);
      if (data.totalAmount && data.currency) contextParts.push(`Total: ${data.currency} ${data.totalAmount.toLocaleString()}`);
      
      if (contextParts.length > 0) {
        userPrompt += `\n\nContext:\n${contextParts.join("\n")}`;
      }
      
      aiMessages.push({ role: "user", content: userPrompt });
    } else if (data) {
      aiMessages.push({ 
        role: "user", 
        content: `Please analyze the following data:\n\n${JSON.stringify(data, null, 2)}` 
      });
    }

    // Ground the answer in live, tenant-scoped rows before streaming it.
    if (type === "chat" && organizationId) {
      const scope: ToolScope = {
        organizationId,
        businessId: businessId ?? null,
        branchId: branchId ?? null,
        accessibleBranchIds,
        isAdmin: isAdminRole(userRole),
      };
      aiMessages = await runDataToolLoop(supabaseClient, aiMessages, settings, scope, {
        base_currency: currencyCtx.baseCurrency,
        mixed_across_businesses: currencyCtx.mixed,
        business_currencies: currencyCtx.businessCurrencies,
        active_currencies: currencyCtx.activeCurrencies,
        country: currencyCtx.country,
      });
    }

    const isStreaming = type === "chat";
    const response = await makeAIRequest(supabaseClient, aiMessages, type, isStreaming, settings);

    if (isStreaming || !response.ok) {
      return response;
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    if (["categorize_expense", "analyze_invoice", "suggest_actions", "match_transactions"].includes(type)) {
      try {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch ? jsonMatch[1] : content;
        const parsed = JSON.parse(jsonStr.trim());
        return new Response(
          JSON.stringify({ success: true, data: parsed }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch {
        return new Response(
          JSON.stringify({ success: true, data: { raw: content } }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Email assist returns improved message directly
    if (type === "email_assist") {
      return new Response(
        JSON.stringify({ success: true, data: { content: content.trim(), improvedMessage: content.trim() } }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Document text returns the generated text directly
    if (type === "document_text") {
      return new Response(
        JSON.stringify({ success: true, data: { content: content.trim(), text: content.trim() } }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: { content } }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("AI assistant error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

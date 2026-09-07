/**
 * AI capability scope — which modules the assistant may read FOR THIS CALLER.
 *
 * Why this exists: the assistant runs on the service-role key, so RLS does not
 * apply to its reads. Tenant/business/branch scoping is handled in
 * `dataTools.ts`; this module answers the orthogonal question "is this caller
 * allowed to read this module at all?".
 *
 * Rules:
 *   1. Deny by default. A tool or table with no declared module requirement is
 *      unreachable.
 *   2. Permissions are resolved server-side from the caller's identity via
 *      `user_has_module_permission(_user_id, _org_id, _module, 'read')` — never
 *      from anything the browser sends, and never from the conversation's
 *      `app_key` (cross-application reasoning stays allowed when authorized).
 *   3. Resolution is per request only. Nothing is cached across requests or
 *      stored on the conversation row.
 */

/** Modules the assistant can read from. Mirrors `permission_group_rules.module`. */
export const AI_MODULES = [
  "clients",
  "loans",
  "applications",
  "repayments",
  "collections",
  "loan_products",
  "accounting",
  "treasury",
  "branches",
  "team",
  "reports",
  "audit",
  "settings",
] as const;

export type AiModule = typeof AI_MODULES[number];

/**
 * Module requirement per allowlisted table. Every key of `DATA_TABLES` MUST
 * appear here — the architecture test enforces it, and a missing entry makes
 * the table unreachable rather than public.
 */
export const TABLE_MODULE: Record<string, AiModule> = {
  // Microfinance core
  mf_clients: "clients",
  mf_groups: "clients",
  contacts: "clients",

  mf_loans: "loans",
  mf_loan_applications: "applications",
  mf_repayments: "repayments",

  // Finance / accounting
  expenses: "accounting",
  payments: "accounting",
  accounts: "accounting",
  journal_entries: "accounting",
  fixed_assets: "accounting",

  // Treasury
  bank_accounts: "treasury",
  bank_transactions: "treasury",
  exchange_rates: "treasury",

  // Organisation & configuration
  branches: "branches",
  employees: "team",
  businesses: "settings",
  business_active_currencies: "settings",
};

/**
 * Module requirement per tool. `null` means the tool exposes no tenant business
 * data of its own (schema description, currency metadata) and is always
 * available — its *underlying* reads are still gated per table.
 */
export const TOOL_MODULE: Record<string, AiModule | null> = {
  describe_schema: null,
  get_currency_context: null,
  query_data: null, // gated by the table's module instead
  count_rows: null, // gated by the table's module instead
};


export interface CapabilitySet {
  /** Modules this caller may read. */
  modules: Set<string>;
  /** True for trusted server-to-server callers (service-role key). */
  unrestricted: boolean;
}

export const UNRESTRICTED_CAPABILITIES: CapabilitySet = {
  modules: new Set<string>(AI_MODULES),
  unrestricted: true,
};

export const NO_CAPABILITIES: CapabilitySet = {
  modules: new Set<string>(),
  unrestricted: false,
};

/**
 * Resolve the caller's readable modules. One round trip per module, run in
 * parallel; a failed check is treated as "denied", never as "allowed".
 */
export async function resolveCapabilities(
  supabaseClient: any,
  userId: string | null,
  organizationId: string | null,
): Promise<CapabilitySet> {
  if (!userId || !organizationId) return NO_CAPABILITIES;

  const results = await Promise.all(
    AI_MODULES.map(async (module) => {
      const { data, error } = await supabaseClient.rpc("user_has_module_permission", {
        _user_id: userId,
        _org_id: organizationId,
        _module: module,
        _operation: "read",
      });
      if (error) {
        console.error(`capability check failed for module "${module}"`, error);
        return null;
      }
      return data === true ? module : null;
    }),
  );

  return {
    modules: new Set(results.filter((m): m is AiModule => m !== null)),
    unrestricted: false,
  };
}

export function canReadModule(caps: CapabilitySet, module: string | null | undefined): boolean {
  if (caps.unrestricted) return true;
  if (!module) return true; // metadata-only surface
  return caps.modules.has(module);
}

export function canReadTable(caps: CapabilitySet, table: string): boolean {
  const module = TABLE_MODULE[table];
  if (!module) return false; // deny by default: unmapped table
  return canReadModule(caps, module);
}

/** Tables this caller may read, used to narrow describe_schema. */
export function readableTables(caps: CapabilitySet, tables: string[]): string[] {
  return tables.filter((t) => canReadTable(caps, t));
}

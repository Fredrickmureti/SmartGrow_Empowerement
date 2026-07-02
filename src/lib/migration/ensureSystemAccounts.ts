import { supabase } from "@/integrations/supabase/client";

export interface SystemAccountSpec {
  settingKey: string;
  name: string;
  accountType: "asset" | "liability" | "equity" | "income" | "expense";
  code: string;
  detailType: string;
  description: string;
}

/** System accounts that the migration engine requires */
export const REQUIRED_SYSTEM_ACCOUNTS: SystemAccountSpec[] = [
  {
    settingKey: "opening_balance_equity",
    name: "Opening Balance Equity",
    accountType: "equity",
    code: "3100",
    detailType: "opening_balance_equity",
    description: "System account for migration opening balance entries",
  },
  {
    settingKey: "inventory_adjustment",
    name: "Inventory Adjustment",
    accountType: "expense",
    code: "5100",
    detailType: "other_cos",
    description: "System account for inventory value adjustments during migration",
  },
];

/**
 * Ensures a specific system account exists in the COA and is mapped in default_account_settings.
 * Idempotent — safe to call multiple times.
 * 
 * Returns the account ID (existing or newly created).
 */
export async function ensureSystemAccount(
  spec: SystemAccountSpec,
  organizationId: string,
  businessId: string | null
): Promise<string> {
  // 1. Check if an account with this name or code already exists
  // SCOPE-EXEMPT: migration ensures org-level system account exists; business_id is
  // applied on insert (line below). Lookup may match a previously-created shared row.
  const baseQuery = supabase
    .from("accounts")
    .select("id")
    .eq("organization_id", organizationId)
    .or(`name.ilike.%${spec.name}%,code.eq.${spec.code}`);
  const scopedQuery = businessId
    ? baseQuery.eq("business_id", businessId)
    : baseQuery;
  const { data: existing } = await scopedQuery.limit(1);

  let accountId: string;

  if (existing && existing.length > 0) {
    accountId = existing[0].id;
  } else {
    // 2. Check if code is taken (e.g., user has code 3100 for something else)
    const codeTakenBase = supabase
      .from("accounts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("code", spec.code);
    const { data: codeTaken } = await (businessId
      ? codeTakenBase.eq("business_id", businessId).limit(1)
      : codeTakenBase.limit(1));

    const finalCode = codeTaken && codeTaken.length > 0
      ? `${spec.code}-SYS`
      : spec.code;

    // 3. Create the account
    const { data: created, error } = await supabase
      .from("accounts")
      .insert({
        organization_id: organizationId,
        business_id: businessId,
        account_type: spec.accountType,
        detail_type: spec.detailType,
        code: finalCode,
        name: spec.name,
        description: spec.description,
        is_system: true,
        is_active: true,
        opening_balance: 0,
        current_balance: 0,
      })
      .select("id")
      .single();

    if (error) throw error;
    accountId = created.id;
  }

  // 4. Upsert the mapping in default_account_settings.
  // GUARD: default_account_settings.business_id is NOT NULL with per-business RLS.
  // We must NOT write null — that triggers a 403 + NOT NULL violation. If the
  // caller invoked this without a business context, we still create the account
  // but skip the mapping; the migration UI will prompt the user to set defaults
  // once a company is selected.
  if (businessId) {
    await supabase
      .from("default_account_settings")
      .upsert(
        {
          organization_id: organizationId,
          business_id: businessId,
          branch_id: null,
          setting_key: spec.settingKey,
          account_id: accountId,
        },
        { onConflict: "organization_id,business_id,branch_id,setting_key" }
      );
  }

  return accountId;
}

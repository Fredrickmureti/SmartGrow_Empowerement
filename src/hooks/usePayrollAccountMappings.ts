/**
 * Payroll Account Mappings Hook
 *
 * Reads/writes payroll GL account mappings from the canonical
 * `default_account_settings` table (single source of truth for all GL routing).
 * The legacy `payroll_account_mappings` table was dropped in the Settings
 * Architecture Cleanup migration.
 *
 * Standard mapping keys (stored as `setting_key`):
 *   - salary_expense
 *   - net_salary_payable
 *   - [deduction_type]_payable
 *   - [deduction_type]_expense
 *   - loan_deduction_payable
 */
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { usePermissions } from "./usePermissions";
import { toast } from "sonner";

export interface PayrollAccountMapping {
  id: string;
  organization_id: string;
  business_id: string | null;
  mapping_key: string;
  account_id: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  account?: {
    id: string;
    name: string;
    code: string;
    account_type: string;
  };
}

const PAYROLL_KEY_PREFIXES = ["salary_", "net_salary_", "loan_deduction_"];
const PAYROLL_KEY_SUFFIXES = ["_payable", "_expense"];

function isPayrollKey(key: string): boolean {
  return (
    PAYROLL_KEY_PREFIXES.some((p) => key.startsWith(p)) ||
    PAYROLL_KEY_SUFFIXES.some((s) => key.endsWith(s))
  );
}

export function usePayrollAccountMappings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { can } = usePermissions();
  const [mappings, setMappings] = useState<PayrollAccountMapping[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMappings = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      let query = supabase
        .from("default_account_settings")
        .select(`
          id,
          organization_id,
          business_id,
          setting_key,
          account_id,
          created_at,
          updated_at,
          account:accounts(id, name, code, account_type)
        `)
        .eq("organization_id", currentOrg.id);

      if (currentBusiness?.id) {
        query = query.or(`business_id.is.null,business_id.eq.${currentBusiness.id}`);
      }

      const { data, error } = await query;
      if (error) throw error;

      const rows = (data || [])
        .filter((r: any) => isPayrollKey(r.setting_key))
        .map((r: any) => ({
          id: r.id,
          organization_id: r.organization_id,
          business_id: r.business_id,
          mapping_key: r.setting_key,
          account_id: r.account_id,
          description: null,
          is_active: true,
          created_at: r.created_at,
          updated_at: r.updated_at,
          account: r.account,
        })) as PayrollAccountMapping[];

      setMappings(rows);
    } catch (error) {
      console.error("Error fetching payroll account mappings:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchMappings();
  }, [fetchMappings]);

  const getAccountId = useCallback(
    (key: string): string | null => {
      const businessMapping = mappings.find(
        (m) => m.mapping_key === key && m.business_id === currentBusiness?.id
      );
      if (businessMapping) return businessMapping.account_id;
      const orgMapping = mappings.find((m) => m.mapping_key === key && !m.business_id);
      return orgMapping?.account_id || null;
    },
    [mappings, currentBusiness?.id]
  );

  const getMappingsMap = useCallback((): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const m of mappings.filter((m) => !m.business_id)) {
      map[m.mapping_key] = m.account_id;
    }
    for (const m of mappings.filter((m) => m.business_id === currentBusiness?.id)) {
      map[m.mapping_key] = m.account_id;
    }
    return map;
  }, [mappings, currentBusiness?.id]);

  const upsertMapping = async (key: string, accountId: string, _description?: string) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!can("managePayroll")) {
      toast.error("You don't have permission to manage payroll settings");
      throw new Error("Permission denied");
    }

    // Go through the canonical server-side writer so every payroll-mapping
    // write — single-row edits, bulk Apply-All-Suggested, and Create-and-Map —
    // funnels through the same UPSERT helper. This removes a SELECT-then-write
    // race window and guarantees consistent ON CONFLICT semantics.
    const { error } = await (supabase as any).rpc("payroll_apply_proposed_mappings", {
      _org_id: currentOrg.id,
      _business_id: currentBusiness?.id ?? null,
      _accept: [{ setting_key: key, account_id: accountId }],
      _branch_id: null,
    });
    if (error) throw error;

    toast.success("Account mapping saved");
    await fetchMappings();
  };

  const deleteMapping = async (id: string) => {
    if (!can("managePayroll")) throw new Error("Permission denied");
    const { error } = await supabase.from("default_account_settings").delete().eq("id", id);
    if (error) throw error;
    toast.success("Account mapping removed");
    await fetchMappings();
  };

  return {
    mappings,
    isLoading,
    getAccountId,
    getMappingsMap,
    upsertMapping,
    deleteMapping,
    refreshMappings: fetchMappings,
  };
}

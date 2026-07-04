import { normalizeError } from "@/services/resilience";
/**
 * Stage D — work entry types CRUD hook.
 *
 * Pack-default rows (`business_id IS NULL`) are read-only. Tenants override
 * by inserting a business-scoped row with the same `code` (unique constraint
 * `(business_id, code)`).
 */
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export interface WorkEntryType {
  id: string;
  organization_id: string;
  business_id: string | null;
  localization_pack_id: string | null;
  code: string;
  name: string;
  is_paid: boolean;
  counts_as_worked: boolean;
  multiplier_normal: number;
  multiplier_overtime: number;
  accounting_tag: string | null;
  sequence: number;
  is_active: boolean;
  version: number;
}

export interface WorkEntryTypeInput {
  code: string;
  name: string;
  is_paid: boolean;
  counts_as_worked: boolean;
  multiplier_normal: number;
  multiplier_overtime: number;
  accounting_tag?: string | null;
  sequence?: number;
  is_active?: boolean;
  /** Version last read by the client — required for optimistic locking on update. */
  version?: number;
}

export function useWorkEntryTypes() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: types = [], isLoading } = useQuery({
    queryKey: ["payroll-work-entry-types", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<WorkEntryType[]> => {
      // Pull pack defaults (business_id IS NULL) AND tenant overrides for this business.
      let q = supabase
        .from("payroll_work_entry_types" as any)
        .select("*")
        .eq("organization_id", currentOrg!.id)
        .order("sequence", { ascending: true });
      if (currentBusiness?.id) {
        q = q.or(`business_id.is.null,business_id.eq.${currentBusiness.id}`);
      } else {
        q = q.is("business_id", null);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as WorkEntryType[];
    },
  });

  // Operational intelligence per WET — rows/employees used in the last 90d,
  // rules referencing worked_hours['CODE'], and leave types routing here.
  const { data: impact = {} } = useQuery({
    queryKey: ["payroll-wet-impact", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<Record<string, WorkEntryTypeImpact>> => {
      const { data, error } = await supabase.rpc("wet_impact_metrics" as any, {
        _org_id: currentOrg!.id,
        _business_id: currentBusiness?.id ?? null,
      });
      if (error) throw error;
      const map: Record<string, WorkEntryTypeImpact> = {};
      for (const row of (data ?? []) as any[]) {
        map[row.work_entry_type_id] = {
          rowsLast90d: Number(row.rows_last_90d ?? 0),
          employeesLast90d: Number(row.employees_last_90d ?? 0),
          rulesReferencing: Number(row.rules_referencing ?? 0),
          leaveTypesRouted: Number(row.leave_types_routed ?? 0),
        };
      }
      return map;
    },
  });

  const upsert = useMutation({
    mutationFn: async (input: WorkEntryTypeInput & { id?: string }) => {
      if (!currentOrg?.id) throw new Error("No organization");
      if (!currentBusiness?.id) throw new Error("Select a company before editing work entry types");
      const payload: any = {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        is_paid: input.is_paid,
        counts_as_worked: input.counts_as_worked,
        multiplier_normal: input.multiplier_normal,
        multiplier_overtime: input.multiplier_overtime,
        accounting_tag: input.accounting_tag ?? null,
        sequence: input.sequence ?? 100,
        is_active: input.is_active ?? true,
      };
      if (input.id) {
        if (input.version === undefined || input.version === null) {
          throw new Error("Missing version for update — refresh and try again.");
        }
        // Optimistic locking: only update when the row's version matches
        // what the client last read. A concurrent edit will change the
        // version and this update will affect 0 rows.
        const { data: updated, error } = await supabase
          .from("payroll_work_entry_types" as any)
          .update(payload)
          .eq("id", input.id)
          .eq("version", input.version)
          .select("id, version");
        if (error) throw error;
        if (!updated || (updated as any[]).length === 0) {
          const err: any = new Error(
            "This work entry type was changed by someone else. Refresh to load the latest version and re-apply your edits."
          );
          err.code = "STALE_VERSION";
          throw err;
        }
      } else {
        const { error } = await supabase
          .from("payroll_work_entry_types" as any)
          .insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-work-entry-types"] });
      toast.success("Work entry type saved");
    },
    onError: (e: any) => {
      if (e?.code === "STALE_VERSION") toast.warning(e.message);
      else toast.error(normalizeError(e).message ?? "Save failed");
    },
  });

  const overrideFromPack = useMutation({
    mutationFn: async (packDefault: WorkEntryType) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("Select a company");
      // Guard against the classic "override already exists" 409 by checking
      // for an existing tenant row up-front. If one is present we surface a
      // clear message instead of a unique-violation.
      const { data: existing, error: findErr } = await supabase
        .from("payroll_work_entry_types" as any)
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("code", packDefault.code)
        .maybeSingle();
      if (findErr) throw findErr;
      if (existing) {
        const err: any = new Error("An override for this code already exists — edit the tenant copy instead.");
        err.code = "OVERRIDE_EXISTS";
        throw err;
      }
      const { error } = await supabase
        .from("payroll_work_entry_types" as any)
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          localization_pack_id: packDefault.localization_pack_id,
          code: packDefault.code,
          name: packDefault.name,
          is_paid: packDefault.is_paid,
          counts_as_worked: packDefault.counts_as_worked,
          multiplier_normal: packDefault.multiplier_normal,
          multiplier_overtime: packDefault.multiplier_overtime,
          accounting_tag: packDefault.accounting_tag,
          sequence: packDefault.sequence,
          is_active: packDefault.is_active,
        });
      if (error) {
        // Postgres unique_violation — the pre-check race lost. Surface a
        // clear message instead of the generic "conflict" toast.
        if ((error as any).code === "23505") {
          const err: any = new Error("An override for this code already exists — edit the tenant copy instead.");
          err.code = "OVERRIDE_EXISTS";
          throw err;
        }
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-work-entry-types"] });
      toast.success("Override created — edit the tenant copy now");
    },
    onError: (e: any) => {
      if (e?.code === "OVERRIDE_EXISTS") {
        toast.info(e.message);
      } else {
        toast.error(normalizeError(e).message ?? "Override failed");
      }
    },
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("payroll_work_entry_types" as any)
        .update({ is_active: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-work-entry-types"] });
      toast.success("Archived");
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Archive failed"),
  });

  return { types, impact, isLoading, upsert, overrideFromPack, archive };
}

export interface WorkEntryTypeImpact {
  rowsLast90d: number;
  employeesLast90d: number;
  rulesReferencing: number;
  leaveTypesRouted: number;
}

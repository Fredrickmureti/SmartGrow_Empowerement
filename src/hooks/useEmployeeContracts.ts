import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "./usePermissions";
import { toast } from "sonner";

export interface EmployeeContract {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  contract_reference: string;
  name: string;
  start_date: string;
  end_date: string | null;
  status: "new" | "running" | "expired" | "cancelled";
  wage: number;
  housing_allowance: number;
  transport_allowance: number;
  other_allowances: Record<string, number>;
  working_schedule: "full_time" | "part_time" | "contract" | "freelance";
  salary_structure_id: string | null;
  notes: string | null;
  compensation_mode: "structure" | "flat_wage" | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined data
  employee?: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string;
  };
}

export interface ContractFormData {
  employee_id: string;
  name: string;
  start_date: string;
  end_date?: string | null;
  status?: EmployeeContract["status"];
  wage: number;
  housing_allowance?: number;
  transport_allowance?: number;
  other_allowances?: Record<string, number>;
  working_schedule?: EmployeeContract["working_schedule"];
  salary_structure_id?: string | null;
  notes?: string | null;
  compensation_mode?: "structure" | "flat_wage" | null;
}

export function useEmployeeContracts(employeeId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { can } = usePermissions();
  const [contracts, setContracts] = useState<EmployeeContract[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchContracts = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      let query = (supabase as any)
        .from("employee_contracts")
        .select(`
          *,
          employee:employees(id, first_name, last_name, employee_number)
        `)
        .eq("organization_id", currentOrg.id)
        .order("start_date", { ascending: false });

      query = query.eq("business_id", currentBusiness!.id);
      if (employeeId) {
        query = query.eq("employee_id", employeeId);
      }

      const { data, error } = await query;

      if (error) throw error;
      setContracts((data || []) as unknown as EmployeeContract[]);
    } catch (error) {
      console.error("Error fetching employee contracts:", error);
      toast.error("Failed to fetch employee contracts");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, employeeId]);

  useEffect(() => {
    fetchContracts();
  }, [fetchContracts]);

  const getNextReference = async (): Promise<string> => {
    if (!currentOrg) return "CON-0001";

    const { data, error } = await (supabase as any).rpc("get_next_contract_reference", {
      p_org_id: currentOrg.id,
    });

    if (error) {
      console.error("Error getting contract reference:", error);
      return `CON-${Date.now()}`;
    }

    return data || "CON-0001";
  };

  const createContract = async (formData: ContractFormData) => {
    if (!currentOrg || !user) throw new Error("No organization selected");
    if (!can("manageEmployees")) throw new Error("You don't have permission to create contracts");

    const contractReference = await getNextReference();

    const { data, error } = await (supabase as any)
      .from("employee_contracts")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        employee_id: formData.employee_id,
        contract_reference: contractReference,
        name: formData.name,
        start_date: formData.start_date,
        end_date: formData.end_date || null,
        status: formData.status || "new",
        wage: formData.wage,
        housing_allowance: formData.housing_allowance || 0,
        transport_allowance: formData.transport_allowance || 0,
        other_allowances: formData.other_allowances || {},
        working_schedule: formData.working_schedule || "full_time",
        salary_structure_id: formData.salary_structure_id || null,
        compensation_mode:
          formData.compensation_mode ??
          (formData.salary_structure_id
            ? "structure"
            : (formData.wage ?? 0) > 0
              ? "flat_wage"
              : null),
        notes: formData.notes || null,
        created_by: user.id,
      })
      .select()
      .single();

    if (error) throw error;

    toast.success(`Contract ${contractReference} created successfully`);
    await fetchContracts();
    return data;
  };

  const updateContract = async (id: string, updates: Partial<ContractFormData>) => {
    if (!can("manageEmployees")) throw new Error("You don't have permission to update contracts");

    const { error } = await (supabase as any)
      .from("employee_contracts")
      .update(updates)
      .eq("id", id);

    if (error) throw error;

    toast.success("Contract updated successfully");
    await fetchContracts();
  };

  const activateContract = async (id: string) => {
    if (!can("manageEmployees")) throw new Error("You don't have permission to activate contracts");

    // Set any other running contracts for this employee to expired
    const contract = contracts.find((c) => c.id === id);
    if (!contract) throw new Error("Contract not found");

    const runningContracts = contracts.filter(
      (c) => c.employee_id === contract.employee_id && c.status === "running" && c.id !== id
    );

    for (const rc of runningContracts) {
      await (supabase as any)
        .from("employee_contracts")
        .update({ status: "expired" })
        .eq("id", rc.id);
    }

    // Activate the new contract (trigger will sync wage to employee).
    // Use .select() so we surface any RLS/trigger failure that would otherwise
    // silently leave the row in 'new' state and make the UI look stuck.
    const { data, error } = await (supabase as any)
      .from("employee_contracts")
      .update({ status: "running" })
      .eq("id", id)
      .select("id, status")
      .single();

    if (error) {
      // The activation trigger raises 'CONTRACT_COMPENSATION_INCOMPLETE: <jsonb>'.
      // Surface a structured error so callers can render a remediation dialog
      // instead of a raw Postgres message.
      const msg = String((error as any)?.message ?? "");
      const marker = "CONTRACT_COMPENSATION_INCOMPLETE:";
      if (msg.includes(marker)) {
        try {
          const payload = JSON.parse(msg.slice(msg.indexOf(marker) + marker.length).trim());
          const structured = new Error(
            "Compensation setup is incomplete for this contract.",
          ) as Error & { code?: string; payload?: unknown };
          structured.code = "CONTRACT_COMPENSATION_INCOMPLETE";
          structured.payload = payload;
          throw structured;
        } catch {
          // fall through to raw error
        }
      }
      throw error;
    }
    if (!data || data.status !== "running") {
      throw new Error("Activation did not persist — please retry or check permissions.");
    }

    // Optimistically reflect the change so the button updates immediately,
    // then re-fetch to pick up trigger side-effects.
    setContracts((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, status: "running" }
          : c.employee_id === contract.employee_id && c.status === "running"
            ? { ...c, status: "expired" }
            : c
      )
    );

    toast.success("Contract activated — employee compensation synced");
    await fetchContracts();
  };

  const cancelContract = async (id: string) => {
    if (!can("manageEmployees")) throw new Error("You don't have permission to cancel contracts");

    const { data, error } = await (supabase as any)
      .from("employee_contracts")
      .update({ status: "cancelled" })
      .eq("id", id)
      .select("id, status")
      .single();

    if (error) throw error;
    if (!data || data.status !== "cancelled") {
      throw new Error("Cancellation did not persist — please retry or check permissions.");
    }

    setContracts((prev) => prev.map((c) => (c.id === id ? { ...c, status: "cancelled" } : c)));
    toast.success("Contract cancelled");
    await fetchContracts();
  };

  const deleteContract = async (id: string) => {
    if (!can("manageEmployees")) throw new Error("You don't have permission to delete contracts");

    const contract = contracts.find((c) => c.id === id);
    if (contract?.status === "running") {
      throw new Error("Cannot delete a running contract. Cancel it first.");
    }

    const { error } = await (supabase as any)
      .from("employee_contracts")
      .delete()
      .eq("id", id);

    if (error) throw error;

    toast.success("Contract deleted");
    await fetchContracts();
  };

  const activeContract = contracts.find((c) => c.status === "running") || null;

  return {
    contracts,
    activeContract,
    isLoading,
    createContract,
    updateContract,
    activateContract,
    cancelContract,
    deleteContract,
    refreshContracts: fetchContracts,
  };
}

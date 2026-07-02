import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { usePermissions } from "./usePermissions";
import { toast } from "sonner";

export type DepartmentStatus = "active" | "archived" | "dissolved";

export interface Department {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  manager_id: string | null;
  parent_department_id: string | null;
  is_active: boolean;
  status: DepartmentStatus;
  archived_at: string | null;
  archived_by: string | null;
  dissolved_at: string | null;
  dissolved_by: string | null;
  created_at: string;
  updated_at: string;
  manager?: {
    id: string;
    first_name: string;
    last_name: string;
  } | null;
  parent_department?: {
    id: string;
    name: string;
  } | null;
}

export interface DepartmentFormData {
  name: string;
  code?: string | null;
  description?: string | null;
  manager_id?: string | null;
  parent_department_id?: string | null;
  is_active?: boolean;
}

export function useDepartments() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { can } = usePermissions();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchDepartments = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      let query = supabase
        .from("departments")
        .select(`
          *,
          manager:employees!departments_manager_id_fkey(id, first_name, last_name)
        `)
        .eq("organization_id", currentOrg.id)
        .order("name");

      if (currentBusiness) {
        query = query.eq("business_id", currentBusiness.id);
      }

      const { data, error } = await query;

      if (error) throw error;
      
      // Transform data to include parent_department info
      const deptMap = new Map<string, any>((data || []).map((d: any) => [d.id as string, d]));
      const transformed = (data || []).map((d: any) => ({
        ...d,
        parent_department: d.parent_department_id 
          ? deptMap.get(d.parent_department_id) 
            ? { id: d.parent_department_id, name: (deptMap.get(d.parent_department_id) as any)?.name || "" }
            : null
          : null,
      }));
      
      setDepartments(transformed as Department[]);
    } catch (error) {
      console.error("Error fetching departments:", error);
      toast.error("Failed to fetch departments");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments]);

  const createDepartment = async (departmentData: DepartmentFormData) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!can("manageDepartments")) throw new Error("You don't have permission to create departments");

    const { data, error } = await supabase
      .from("departments")
      .insert({
        ...departmentData,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
      })
      .select()
      .single();

    if (error) throw error;

    toast.success("Department created successfully");
    await fetchDepartments();
    return data;
  };

  const updateDepartment = async (id: string, updates: Partial<DepartmentFormData>) => {
    if (!can("manageDepartments")) throw new Error("You don't have permission to update departments");
    const { error } = await supabase
      .from("departments")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;

    toast.success("Department updated successfully");
    await fetchDepartments();
  };

  const deleteDepartment = async (id: string) => {
    if (!can("manageDepartments")) throw new Error("You don't have permission to delete departments");
    // Archive via lifecycle RPC (terminal "delete" is dissolveDepartment).
    const { error } = await (supabase as any).rpc("archive_department", {
      _department_id: id,
      _reason: null,
    });
    if (error) throw error;
    toast.success("Department archived");
    await fetchDepartments();
  };

  const archiveDepartment = async (id: string, reason?: string) => {
    if (!can("manageDepartments")) throw new Error("You don't have permission to archive departments");
    const { error } = await (supabase as any).rpc("archive_department", {
      _department_id: id,
      _reason: reason ?? null,
    });
    if (error) throw error;
    toast.success("Department archived");
    await fetchDepartments();
  };

  const restoreDepartment = async (id: string) => {
    if (!can("manageDepartments")) throw new Error("You don't have permission to restore departments");
    const { error } = await (supabase as any).rpc("restore_department", {
      _department_id: id,
    });
    if (error) throw error;
    toast.success("Department restored");
    await fetchDepartments();
  };

  const dissolveDepartment = async (id: string) => {
    if (!can("manageDepartments")) throw new Error("You don't have permission to dissolve departments");
    const { error } = await (supabase as any).rpc("dissolve_department", {
      _department_id: id,
    });
    if (error) throw error;
    toast.success("Department dissolved");
    await fetchDepartments();
  };

  const activeDepartments = departments.filter(d => (d.status ?? (d.is_active ? "active" : "archived")) === "active");
  const archivedDepartments = departments.filter(d => d.status === "archived");
  const dissolvedDepartments = departments.filter(d => d.status === "dissolved");

  return {
    departments,
    activeDepartments,
    archivedDepartments,
    dissolvedDepartments,
    isLoading,
    createDepartment,
    updateDepartment,
    deleteDepartment,
    archiveDepartment,
    restoreDepartment,
    dissolveDepartment,
    refreshDepartments: fetchDepartments,
  };
}

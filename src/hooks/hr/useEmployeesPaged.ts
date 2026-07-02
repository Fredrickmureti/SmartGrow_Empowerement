/**
 * Wave H F6 — Server-side, cursor-paginated employees directory.
 *
 * Single round-trip per page via `public.list_employees_paged` (SECURITY
 * INVOKER, RLS enforced). Filters (search, status, department, position,
 * location, health) run on the server. Health verdict is joined in.
 *
 * Use this hook ONLY on the directory page. The 22 other consumers of
 * `useEmployees` (form pickers, payroll, projects, leave, reports) still
 * want the full-list shape and continue using that hook.
 */
import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/hooks/usePermissions";
import { useEmployeeDirectoryScope } from "./useEmployeeDirectoryScope";
import { assertHrScope } from "@/lib/hr/scopingAssertions";
import type { Employee } from "@/hooks/useEmployees";
import type { SetupVerdict } from "@/hooks/hr/useEmployeeSetupHealth";

export interface EmployeesPagedFilters {
  search: string;
  status: "all" | "active" | "inactive" | "drafts";
  departmentId: string;          // "all" disables
  positionId: string;            // "all" disables
  locationId: string;            // "all" disables
  health: "all" | SetupVerdict;
}

export interface DirectoryEmployee extends Employee {
  health_verdict: SetupVerdict | null;
  manager_first_name: string | null;
  manager_last_name: string | null;
  job_position_id: string | null;
  work_location_id: string | null;
  branch_id: string | null;
}

interface Cursor {
  created_at: string;
  id: string;
}

const PAGE_SIZE = 50;

function shapeRow(row: any): DirectoryEmployee {
  return {
    ...row,
    manager: row.manager_id
      ? {
          id: row.manager_id,
          first_name: row.manager_first_name,
          last_name: row.manager_last_name,
        }
      : null,
    department_name: row.department_name ?? null,
  } as DirectoryEmployee;
}

export function useEmployeesPaged(filters: EmployeesPagedFilters) {
  const { can } = usePermissions();
  const { orgId, businessId, branchIds, branchIdsKey, isReady } =
    useEmployeeDirectoryScope();
  const canViewEmployees = can("viewEmployees");

  const enabled = Boolean(isReady && canViewEmployees);

  const query = useInfiniteQuery({
    queryKey: [
      "employees-paged",
      orgId,
      businessId,
      branchIdsKey,
      filters,
    ],
    enabled,
    initialPageParam: null as Cursor | null,
    queryFn: async ({ pageParam }) => {
      assertHrScope({
        hook: "useEmployeesPaged",
        orgId: orgId!,
        businessId: businessId!,
      });
      const cursor = pageParam as Cursor | null;
      const { data, error } = await supabase.rpc(
        "list_employees_paged" as any,
        {
          p_org_id: orgId!,
          p_business_id: businessId!,
          p_branch_ids: branchIds,
          p_search: filters.search?.trim() || null,
          p_status: filters.status,
          p_department_id:
            filters.departmentId === "all" ? null : filters.departmentId,
          p_position_id:
            filters.positionId === "all" ? null : filters.positionId,
          p_location_id:
            filters.locationId === "all" ? null : filters.locationId,
          p_health: filters.health === "all" ? null : filters.health,
          p_cursor_created_at: cursor?.created_at ?? null,
          p_cursor_id: cursor?.id ?? null,
          p_page_size: PAGE_SIZE,
        },
      );
      if (error) throw error;
      const rows = (data ?? []) as any[];
      return rows.map(shapeRow);
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage || lastPage.length < PAGE_SIZE) return undefined;
      const last = lastPage[lastPage.length - 1];
      return { created_at: last.created_at, id: last.id } as Cursor;
    },
  });


  const employees = useMemo(
    () => (query.data?.pages ?? []).flat(),
    [query.data],
  );

  return {
    employees,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: !!query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
    error: query.error,
  };
}

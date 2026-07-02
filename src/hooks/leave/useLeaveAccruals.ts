import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useLeaveTypes, LeaveType } from "./useLeaveTypes";
import { useLeaveAllocations } from "./useLeaveAllocations";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

interface AccrualResult {
  employeeId: string;
  employeeName: string;
  leaveTypeName: string;
  daysAccrued: number;
  status: "success" | "error";
  message?: string;
}

/**
 * Hook for processing leave accruals.
 * Reads accrual configuration from leave types and creates
 * allocation records for eligible employees.
 */
export function useLeaveAccruals() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { leaveTypes } = useLeaveTypes();
  const { createAllocation, refreshAllocations } = useLeaveAllocations();
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastResults, setLastResults] = useState<AccrualResult[]>([]);

  /**
   * Get leave types that have accrual enabled
   */
  const getAccrualLeaveTypes = useCallback((): LeaveType[] => {
    return leaveTypes.filter(t => t.accrual_enabled && t.is_active);
  }, [leaveTypes]);

  /**
   * Calculate accrual amount based on frequency
   */
  const calculateAccrualAmount = (rate: number, frequency: string): number => {
    switch (frequency) {
      case "monthly": return rate;
      case "quarterly": return rate;
      case "semi_annual": return rate;
      case "annual": return rate;
      default: return rate;
    }
  };

  /**
   * Check if accrual should run based on frequency and last accrual date
   */
  const shouldAccrue = (frequency: string, lastAccrualDate?: string): boolean => {
    if (!lastAccrualDate) return true; // First accrual

    const last = new Date(lastAccrualDate);
    const now = new Date();
    const diffMs = now.getTime() - last.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    switch (frequency) {
      case "monthly": return diffDays >= 28;
      case "quarterly": return diffDays >= 84;
      case "semi_annual": return diffDays >= 180;
      case "annual": return diffDays >= 360;
      default: return diffDays >= 28;
    }
  };

  /**
   * Process accruals for all eligible employees and leave types
   */
  const processAccruals = useCallback(async (year?: number): Promise<AccrualResult[]> => {
    if (!currentOrg || !user) {
      toast.error("No organization or user context");
      return [];
    }

    setIsProcessing(true);
    const results: AccrualResult[] = [];
    const currentYear = year || new Date().getFullYear();

    try {
      const accrualTypes = getAccrualLeaveTypes();
      if (accrualTypes.length === 0) {
        toast.info("No leave types have accrual enabled");
        setIsProcessing(false);
        return [];
      }

      // Get active employees
      let empQuery = supabase
        .from("v_employees_canonical")
        .select("id, first_name, last_name, employee_number, hire_date")
        .eq("organization_id", currentOrg.id)
        .eq("is_operationally_active", true);

      empQuery = empQuery.eq("business_id", currentBusiness!.id);
      const { data: employees, error: empError } = await empQuery;
      if (empError) throw empError;

      // Get existing accrual allocations for this year
      // SCOPE-EXEMPT: accrual idempotency check joins to employees (already business-scoped above)
      const { data: existingAccruals, error: accError } = await (supabase as any)
        .from("leave_allocations")
        .select("employee_id, leave_type_id, created_at")
        .eq("organization_id", currentOrg.id)
        .eq("allocation_type", "accrual")
        .eq("year", currentYear)
        .order("created_at", { ascending: false });

      if (accError) throw accError;

      for (const leaveType of accrualTypes) {
        for (const emp of employees || []) {
          const empName = `${emp.first_name} ${emp.last_name}`;

          // Find last accrual for this employee + leave type
          const lastAccrual = (existingAccruals || []).find(
            (a: any) => a.employee_id === emp.id && a.leave_type_id === leaveType.id
          );

          if (!shouldAccrue(leaveType.accrual_frequency, lastAccrual?.created_at)) {
            results.push({
              employeeId: emp.id,
              employeeName: empName,
              leaveTypeName: leaveType.name,
              daysAccrued: 0,
              status: "success",
              message: "Not due for accrual yet",
            });
            continue;
          }

          const daysToAccrue = calculateAccrualAmount(leaveType.accrual_rate, leaveType.accrual_frequency);

          try {
            await createAllocation({
              employee_id: emp.id,
              leave_type_id: leaveType.id,
              allocation_type: "accrual",
              year: currentYear,
              days_allocated: daysToAccrue,
              days_used: 0,
              days_pending: 0,
              effective_date: new Date().toISOString().split("T")[0],
              expiry_date: null,
              notes: `Auto-accrual: ${leaveType.accrual_rate} days (${leaveType.accrual_frequency})`,
              approved_by: user.id,
              approved_at: new Date().toISOString(),
              created_by: user.id,
              business_id: currentBusiness?.id || null,
            });

            results.push({
              employeeId: emp.id,
              employeeName: empName,
              leaveTypeName: leaveType.name,
              daysAccrued: daysToAccrue,
              status: "success",
            });
          } catch (err: any) {
            results.push({
              employeeId: emp.id,
              employeeName: empName,
              leaveTypeName: leaveType.name,
              daysAccrued: 0,
              status: "error",
              message: err.message,
            });
          }
        }
      }

      const successCount = results.filter(r => r.status === "success" && r.daysAccrued > 0).length;
      const skipCount = results.filter(r => r.daysAccrued === 0).length;
      const errorCount = results.filter(r => r.status === "error").length;

      if (successCount > 0) {
        toast.success(`Accruals processed: ${successCount} allocated, ${skipCount} skipped, ${errorCount} errors`);
      } else if (skipCount > 0) {
        toast.info("No accruals were due at this time");
      }

      await refreshAllocations();
    } catch (error: any) {
      console.error("Accrual processing error:", error);
      toast.error(`Accrual processing failed: ${normalizeError(error).message}`);
    } finally {
      setIsProcessing(false);
      setLastResults(results);
    }

    return results;
  }, [currentOrg, currentBusiness, user, getAccrualLeaveTypes, createAllocation, refreshAllocations]);

  return {
    processAccruals,
    isProcessing,
    lastResults,
    getAccrualLeaveTypes,
  };
}

import { useToast } from "./use-toast";
import { PayrollRun } from "./usePayroll";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { supabase } from "@/integrations/supabase/client";
import { dispatchMissingMappings } from "./payroll/usePayrollGlReadiness";
import { normalizeError } from "@/services/resilience";

/**
 * Hook for posting payroll transactions to the General Ledger.
 *
 * Delegates to the `post-payroll-gl` Edge Function for server-side
 * account resolution, validation, and atomic GL posting.
 *
 * Wave 3 addition: exposes `validateMappings()` which calls the
 * `validate_payroll_run_mappings` RPC. Callers can preflight a run
 * BEFORE invoking the GL posting function so we don't fail mid-flow
 * with a confusing toast — the user sees the exact missing keys
 * up front and can fix them in Payroll Settings → Account Mappings.
 *
 * Previous versions performed GL posting client-side, which created
 * integrity risks if the user's session dropped mid-posting.
 */
export interface PayrollMappingValidation {
  ok: boolean;
  missing_keys: string[];
  required_keys?: string[];
  existing_keys?: string[];
  summary: string;
}

export function usePayrollGL() {
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  /**
   * Preflight: returns the list of missing account-mapping keys for a
   * given payroll run. Pure read — never posts.
   */
  const validateMappings = async (
    payrollRunId: string,
  ): Promise<PayrollMappingValidation | null> => {
    const { data, error } = await supabase.rpc("validate_payroll_run_mappings", {
      p_run_id: payrollRunId,
    });
    if (error) {
      toast({
        title: "Could not validate mappings",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      return null;
    }
    return data as unknown as PayrollMappingValidation;
  };

  /**
   * Post a payroll run to the General Ledger via server-side Edge Function.
   * Runs the mapping preflight first; aborts (and explains why) if anything
   * is missing, so the user never sees a half-posted run.
   */
  const postPayrollToGL = async (
    payrollRun: PayrollRun,
  ): Promise<string | null> => {
    if (!currentOrg) {
      toast({ title: "No organization selected", variant: "destructive" });
      return null;
    }

    // ── Preflight ──
    const validation = await validateMappings(payrollRun.id);
    if (validation && !validation.ok) {
      // Hydrate the dialog with the canonical resolver rows so labels,
      // required account types, and suggestions are correct (not just keys).
      const { data: resolverRows } = await supabase.rpc(
        "payroll_required_gl_mappings_for_run" as any,
        { p_run_id: payrollRun.id } as any,
      );
      const rows: any[] = Array.isArray(resolverRows) ? resolverRows : [];
      const missingRows = rows.filter((r) => !r.is_mapped);
      const fallbackKind = (k: string) =>
        k.endsWith("_employer_expense") ? "employer_expense" :
        k === "salary_expense" ? "core" :
        k === "net_salary_payable" ? "core" :
        "employee_payable";
      const missing = missingRows.length > 0
        ? missingRows.map((r) => ({
            setting_key: r.setting_key,
            label: r.label ?? r.setting_key,
            rule_code: r.rule_code ?? null,
            kind: r.kind ?? fallbackKind(r.setting_key),
            suggested_account_id: r.suggested_account_id ?? null,
            suggested_account_label: r.suggested_account_label ?? null,
          }))
        : (validation.missing_keys || []).map((k) => ({
            setting_key: k,
            label: k,
            rule_code: null,
            kind: fallbackKind(k) as any,
            suggested_account_id: null,
            suggested_account_label: null,
          }));
      dispatchMissingMappings({
        message: validation.summary || "Missing payroll GL account mappings.",
        missing,
        action: { label: "Open GL Mapping", to: "/hr/payroll/configuration/accounts" },
      });
      toast({
        title: "Cannot post — missing GL mappings",
        description: `${missing.length} mapping(s) missing. Opening setup…`,
        variant: "destructive",
      });
      return null;
    }

    try {
      const { data, error } = await supabase.functions.invoke("post-payroll-gl", {
        body: {
          payroll_run_id: payrollRun.id,
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id || null,
        },
      });

      if (error) {
        toast({
          title: "GL Posting Failed",
          description: normalizeError(error).message || "Failed to post payroll to GL",
          variant: "destructive",
        });
        return null;
      }

      if (data?.error) {
        // Structured missing-mappings error → open the actionable dialog
        if (data.error === "missing_mappings" && Array.isArray(data.missing)) {
          dispatchMissingMappings({
            message: data.message ?? "Missing GL mappings",
            missing: data.missing,
            action: data.action,
          });
          toast({
            title: "Cannot post — missing GL mappings",
            description: `${data.missing.length} mapping(s) missing. Opening setup…`,
            variant: "destructive",
          });
          return null;
        }
        toast({
          title: "GL Posting Failed",
          description: data.error,
          variant: "destructive",
        });
        return null;
      }

      if (data?.already_posted) {
        toast({
          title: "Already Posted",
          description: "This payroll run has already been posted to the GL.",
        });
        return data.journal_entry_id;
      }

      if (data?.missing_accounts?.length > 0) {
        toast({
          title: "Payroll posted to GL",
          description: `Journal entry created. Note: some employer contribution accounts are missing (${data.missing_accounts.join(", ")}).`,
        });
      } else {
        toast({
          title: "Payroll posted to GL",
          description: `Journal entry ${data.journal_entry_number} created for ${payrollRun.payroll_number}`,
        });
      }

      return data.journal_entry_id;
    } catch (err: any) {
      toast({
        title: "GL Posting Failed",
        description: normalizeError(err).message || "Unexpected error posting payroll to GL",
        variant: "destructive",
      });
      return null;
    }
  };

  return {
    postPayrollToGL,
    validateMappings,
  };
}

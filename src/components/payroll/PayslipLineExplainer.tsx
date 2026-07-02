/**
 * PayslipLineExplainer — "Why was this deducted?" popover surfaced on
 * every payslip line. Reads `payslip_lines.source` (jsonb) which the
 * production payroll engine writes when applying a statutory rule.
 *
 * The component is intentionally read-only and country-agnostic: it
 * renders whatever shape the engine wrote. A small adaptor
 * (`adaptSourceToBreakdown`) coerces the most common engine shapes
 * into the shared `BreakdownTable` view contract so the popover and
 * the editor's `RuleSimulator` stay visually identical.
 *
 * Legacy lines (no `source`) render a plain-language fallback.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Info, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  BreakdownTable,
} from "@/features/localization/components/widgets/BreakdownTable";
import { adaptBracketBreakdown } from "../../../supabase/functions/_shared/breakdownAdaptor";
import { parseInputRef, describeInputRef } from "@/lib/payroll/inputRef";
import { usePayslipDrillDown } from "@/hooks/payroll/usePayslipDrillDown";

export interface PayslipLineForExplainer {
  id: string;
  rule_code: string;
  rule_type?: string | null;
  category?: string | null;
  label: string;
  employee_amount: number;
  employer_amount: number;
  source?: any;
  rule_version_id?: string | null;
  rule_version_hash?: string | null;
}

interface Props {
  line: PayslipLineForExplainer;
  currency?: string;
  /**
   * When true, masks money values (delegated to caller so we don't add
   * a permission dependency here). Default false.
   */
  hideAmounts?: boolean;
  /**
   * Portal/self-service mode: hide employer-side contributions (employer NSSF,
   * NITA, etc.). Matches enterprise convention (Workday, ADP, Gusto, BambooHR)
   * — employees see only their own earnings/deductions on payslips.
   */
  hideEmployer?: boolean;
  /**
   * Employee whose payslip this line belongs to — threaded to the
   * drill-down resolver so `contract` / `termination_payout` refs can
   * compute `/hr/employees/{id}` deep links. Optional; the resolver
   * gracefully returns null when missing.
   */
  employeeId?: string | null;
}


/**
 * Adapts the engine's `source` jsonb into the shared breakdown view via the
 * shared, Deno-and-browser-safe `breakdownAdaptor`. Single source of truth
 * shared with the PDF generator (`generate-payslip-pdf`) so the popover and
 * the downloaded payslip cannot drift.
 */
function adaptSourceToBreakdown(line: PayslipLineForExplainer) {
  const v = adaptBracketBreakdown(line);
  return {
    employeeRows: v.employeeRows,
    employerRows: v.employerRows,
    explanation: v.explanation,
  };
}

/**
 * Resolve the rule version chip from `payroll_statutory_rules` so the
 * popover can show "v3 · effective Jan 2025 → Jul 2025". Pure read,
 * tiny query — debounced by react-query cache so opening many
 * popovers on a long payslip is cheap.
 */
function useStatutoryRuleVersion(ruleVersionId?: string | null) {
  return useQuery({
    queryKey: ["statutory-rule-version", ruleVersionId],
    enabled: !!ruleVersionId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_statutory_rules")
        .select("id, rule_code, version, effective_from, effective_to")
        .eq("id", ruleVersionId!)
        .maybeSingle();
      if (error) return null;
      return data;
    },
  });
}

export function PayslipLineExplainer({ line, currency, hideAmounts, hideEmployer, employeeId }: Props) {
  const { data: rv } = useStatutoryRuleVersion(line.rule_version_id);
  const adapted = adaptSourceToBreakdown(line);
  const hasSource = line.source && Object.keys(line.source ?? {}).length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          aria-label={`Why was ${line.label} deducted?`}
          title="Why was this deducted?"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[380px] max-h-[70vh] overflow-y-auto">
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium">{line.label}</div>
            <div className="text-[11px] text-muted-foreground flex flex-wrap gap-1.5 mt-1 items-center">
              <span className="font-mono">{line.rule_code}</span>
              {line.rule_type && <Badge variant="outline" className="text-[10px]">{line.rule_type}</Badge>}
              {line.category && <Badge variant="outline" className="text-[10px]">{line.category}</Badge>}
              {rv?.version && (
                <Badge variant="secondary" className="text-[10px]">
                  v{rv.version}
                  {rv.effective_from && ` · from ${rv.effective_from}`}
                  {rv.effective_to && ` → ${rv.effective_to}`}
                </Badge>
              )}
            </div>
          </div>



          <SourceDrillDownRow line={line} employeeId={employeeId} />



          {!hasSource ? (
            <div className="text-xs text-muted-foreground rounded-md border bg-muted/30 p-3">
              Calculated by the legacy engine — re-run payroll to populate a
              line-by-line explanation. Final amounts shown on the payslip
              are still authoritative.
            </div>
          ) : !hideAmounts ? (
            <BreakdownTable
              employeeRows={adapted.employeeRows}
              employerRows={hideEmployer ? [] : adapted.employerRows}
              employeeTotal={Number(line.employee_amount ?? 0)}
              employerTotal={hideEmployer ? 0 : Number(line.employer_amount ?? 0)}
              explanation={adapted.explanation}
              currency={currency}
            />
          ) : (

            <div className="text-xs text-muted-foreground rounded-md border bg-muted/30 p-3">
              You don't have permission to view per-line salary detail.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * P4 — renders the "Source" row. When the resolver returns a drill
 * target (and the caller has the required permission), the row becomes
 * a navigable Link; otherwise it falls back to descriptive text.
 *
 * Split out so the explainer body stays readable and the hook is only
 * invoked when an `input_ref` is actually present.
 */
function SourceDrillDownRow({
  line,
  employeeId,
}: {
  line: PayslipLineForExplainer;
  employeeId?: string | null;
}) {
  const ref = parseInputRef(line.source);
  const { target } = usePayslipDrillDown(ref, { employeeId });
  if (!ref) return null;

  const body = (
    <>
      <span className="font-medium text-foreground">Source:</span>{" "}
      <span>{describeInputRef(ref)}</span>
      <span className="ml-1 font-mono text-[10px] opacity-60">({ref.kind})</span>
    </>
  );

  if (target) {
    return (
      <Link
        to={target.href}
        aria-label={`${target.label}: ${describeInputRef(ref)}`}
        className="text-[11px] rounded-md border bg-muted/20 px-2 py-1.5 flex items-start gap-1.5 hover:bg-muted/40 hover:border-primary/40 transition-colors text-muted-foreground"
      >
        <span className="flex-1">{body}</span>
        <ExternalLink className="h-3 w-3 mt-0.5 shrink-0 opacity-60" aria-hidden />
      </Link>
    );
  }

  return (
    <div className="text-[11px] text-muted-foreground rounded-md border bg-muted/20 px-2 py-1.5">
      {body}
    </div>
  );
}

// Exported for unit testing — keeps the adaptor pure and verifiable.
export const __test__ = { adaptSourceToBreakdown };

/**
 * PayrollWorkflowStrip (plan §Phase 5b).
 *
 * Visualises the six parallel lifecycles that hang off an APPROVED payroll
 * run: Calculation · Payslips · Posting · Payment · Bank File · Statutory.
 * Each chip renders the workflow's own state and a tooltip explaining what
 * unlocks it, mirroring how SAP HCM / Workday / Oracle HCM present the
 * "Payroll Processing" grid.
 *
 * The strip is intentionally read-only. Actions live in the per-workflow
 * drawers (plan §Phase 5d). This component MUST NOT read `payroll_runs.status`
 * for anything other than the Calculation chip — downstream chips read their
 * own column so the guarantee that workflows are peers survives.
 */
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChildRunSummary } from "@/hooks/payroll/usePayrollRunGroups";

type Tone = "muted" | "info" | "success" | "warning" | "danger";

interface Chip {
  key: string;
  label: string;
  state: string;
  tone: Tone;
  hint: string;
}

const toneClass: Record<Tone, string> = {
  muted: "text-muted-foreground border-border",
  info: "text-sky-700 border-sky-500/40 bg-sky-50 dark:text-sky-300 dark:bg-sky-950/30",
  success: "text-emerald-700 border-emerald-500/40 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/30",
  warning: "text-amber-700 border-amber-500/40 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30",
  danger: "text-rose-700 border-rose-500/40 bg-rose-50 dark:text-rose-300 dark:bg-rose-950/30",
};

function calculationChip(run: ChildRunSummary): Chip {
  const s = run.status;
  const tone: Tone =
    s === "approved" || s === "posted" || s === "paid" || s === "closed" ? "success"
    : s === "cancelled" || s === "reversed" ? "danger"
    : s === "review" ? "info" : "muted";
  return {
    key: "calc", label: "Calculation", state: s, tone,
    hint: "Draft → Calculating → Calculated → Approved. Approval is the immutability seal that unlocks every downstream workflow.",
  };
}

function payslipsChip(run: ChildRunSummary): Chip {
  const s = run.payslip_issuance_status ?? (run.approved_at ? "issued" : "not_issued");
  const tone: Tone = s === "distributed" ? "success" : s === "issued" ? "info" : "muted";
  return {
    key: "payslips", label: "Payslips", state: s.replace(/_/g, " "), tone,
    hint: "Payslip issuance & distribution to employees. Unlocks after Approval — independent of GL Posting and Payment.",
  };
}

function postingChip(run: ChildRunSummary): Chip {
  const s = run.posting_status ?? "not_posted";
  const tone: Tone = s === "posted" ? "success" : s === "reversed" ? "warning" : "muted";
  return {
    key: "posting", label: "GL Posting", state: s.replace(/_/g, " "), tone,
    hint: "Post the payroll journal entry to the General Ledger. Requires Approval only — parallel to Payment.",
  };
}

function paymentChip(run: ChildRunSummary): Chip {
  const s = run.payment_status ?? "pending";
  const tone: Tone =
    s === "fully_paid" ? "success" :
    s === "partially_paid" ? "info" :
    s === "on_hold" ? "warning" : "muted";
  return {
    key: "payment", label: "Payment", state: s.replace(/_/g, " "), tone,
    hint: "Employee disbursement. Projected from payroll_payment_batches — never edited directly. Independent of GL Posting.",
  };
}

function bankFileChip(run: ChildRunSummary): Chip {
  const s = run.bank_file_status ?? "not_generated";
  const tone: Tone =
    s === "acknowledged" ? "success" : s === "sent" ? "info" :
    s === "generated" ? "warning" : "muted";
  return {
    key: "bank", label: "Bank File", state: s.replace(/_/g, " "), tone,
    hint: "Bank export artifact (NACHA, SEPA, KBA, EFT…). Generate → Send → Acknowledged. Requires Approval only.",
  };
}

function statutoryChip(run: ChildRunSummary): Chip {
  // Statutory rollups live at the *period*, not the run — surface at least
  // the "available after approval" state on the run's own strip.
  const approved = !!run.approved_at;
  return {
    key: "statutory", label: "Statutory",
    state: approved ? "available" : "awaiting approval",
    tone: approved ? "info" : "muted",
    hint: "Statutory returns and tax certificates. Available immediately after Approval — you do NOT need to pay employees or post to the GL first.",
  };
}

export interface PayrollWorkflowStripProps {
  run: ChildRunSummary;
  size?: "sm" | "xs";
  className?: string;
}

export function PayrollWorkflowStrip({ run, size = "sm", className }: PayrollWorkflowStripProps) {
  const chips: Chip[] = [
    calculationChip(run),
    payslipsChip(run),
    postingChip(run),
    paymentChip(run),
    bankFileChip(run),
    statutoryChip(run),
  ];
  const chipCls = size === "xs" ? "text-[10px] px-1.5 py-0" : "text-[11px] px-2 py-0.5";
  return (
    <TooltipProvider delayDuration={200}>
      <div className={`flex flex-wrap items-center gap-1 ${className ?? ""}`}>
        {chips.map((c) => (
          <Tooltip key={c.key}>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={`gap-1 font-normal ${toneClass[c.tone]} ${chipCls}`}
              >
                <span className="font-medium">{c.label}</span>
                <span className="opacity-80">·</span>
                <span className="lowercase">{c.state}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs leading-snug">
              {c.hint}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

export default PayrollWorkflowStrip;
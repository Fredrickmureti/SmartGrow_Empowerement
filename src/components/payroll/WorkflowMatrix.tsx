/**
 * WorkflowMatrix (plan §Phase 5c).
 *
 * Portfolio-level overview: rows = payroll runs for the current business,
 * columns = the six parallel workflows, cells = state chip. Mirrors the
 * SAP "Payroll Processing" grid so an operator sees which lifecycle is
 * blocking which run at a glance.
 *
 * Read-only. Click a cell to open the matching per-workflow drawer via the
 * caller-supplied `onCellClick`.
 */
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ChildRunSummary } from "@/hooks/payroll/usePayrollRunGroups";

type Tone = "muted" | "info" | "success" | "warning" | "danger";

const toneClass: Record<Tone, string> = {
  muted: "bg-muted text-muted-foreground",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  danger: "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
};

function cell(state: string | null, mapping: Record<string, Tone>): { text: string; tone: Tone } {
  const s = state ?? "—";
  const tone = mapping[s] ?? "muted";
  return { text: s.replace(/_/g, " "), tone };
}

const CALC: Record<string, Tone> = { approved: "success", posted: "success", paid: "success", closed: "success", review: "info", cancelled: "danger", reversed: "danger" };
const POST: Record<string, Tone> = { posted: "success", reversed: "warning" };
const PAY: Record<string, Tone> = { fully_paid: "success", partially_paid: "info", on_hold: "warning" };
const BANK: Record<string, Tone> = { acknowledged: "success", sent: "success", generated: "info", not_generated_waived: "muted" };
const PAYSLIP: Record<string, Tone> = { distributed: "success", issued: "info" };

export type WorkflowCol = "calc" | "payslips" | "posting" | "payment" | "bank" | "returns";

interface Props {
  runs: ChildRunSummary[];
  onCellClick?: (runId: string, col: WorkflowCol) => void;
}

const COLS: { key: WorkflowCol; label: string }[] = [
  { key: "calc", label: "Calculation" },
  { key: "payslips", label: "Payslips" },
  { key: "posting", label: "GL Posting" },
  { key: "payment", label: "Payment" },
  { key: "bank", label: "Bank File" },
  { key: "returns", label: "Returns" },
];

export function WorkflowMatrix({ runs, onCellClick }: Props) {
  if (!runs.length) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Workflow matrix</CardTitle>
        <CardDescription>
          Six parallel lifecycles per run. Approval unlocks every column to the right of Calculation —
          none of them are chained to each other.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase text-muted-foreground">
              <th className="text-left font-medium py-2 pr-4">Run</th>
              {COLS.map((c) => (
                <th key={c.key} className="text-left font-medium py-2 px-2">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const returnsState = r.approved_at ? "available" : "locked";
              const returnsMap: Record<string, Tone> = { available: "success", locked: "muted" };
              const cells: { key: WorkflowCol; c: { text: string; tone: Tone } }[] = [
                { key: "calc", c: cell(r.status, CALC) },
                { key: "payslips", c: cell(r.payslip_issuance_status ?? (r.approved_at ? "issued" : "not_issued"), PAYSLIP) },
                { key: "posting", c: cell(r.posting_status ?? "not_posted", POST) },
                { key: "payment", c: cell(r.payment_status ?? "pending", PAY) },
                { key: "bank", c: cell(r.bank_file_status ?? "not_generated", BANK) },
                { key: "returns", c: cell(returnsState, returnsMap) },
              ];
              return (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="py-2 pr-4 font-mono text-xs">{r.payroll_number}</td>
                  {cells.map(({ key, c }) => (
                    <td key={key} className="py-2 px-2">
                      <button
                        type="button"
                        onClick={() => onCellClick?.(r.id, key)}
                        className="text-left"
                      >
                        <Badge className={`capitalize ${toneClass[c.tone]}`} variant="secondary">
                          {c.text}
                        </Badge>
                      </button>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
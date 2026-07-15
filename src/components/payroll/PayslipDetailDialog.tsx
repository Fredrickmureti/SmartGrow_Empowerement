/**
 * PayslipDetailDialog — line-by-line payslip drill-in.
 *
 * Two modes:
 *  - Admin (default): shows both Employee and Employer columns and totals.
 *  - Portal (`portalMode`): mirrors enterprise convention (Workday, ADP,
 *    Gusto, BambooHR, Odoo) — employees see only their own earnings and
 *    deductions, NOT employer cost-of-employment contributions (employer
 *    NSSF, NITA, AHL, etc). Adds an intuitive summary header (Gross /
 *    Deductions / Net) similar to the admin Payroll Run preview so the
 *    portal experience is visually consistent and reassuring.
 */
import { useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DetailSheet } from "@/design-system";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Loader2 } from "lucide-react";
import { usePayslipLines } from "@/hooks/payroll/usePayrollWorkspaceData";
import { PayslipLineExplainer } from "@/components/payroll/PayslipLineExplainer";
import { PayslipHeader } from "@/components/payroll/PayslipHeader";
import { usePayslipHeader } from "@/lib/payroll/payslipHeader";
import { classifyPayslipLine } from "@/lib/payroll/payslipClassifier";
import { ReprintButton } from "@/components/printing/ReprintButton";
import { PayslipEventsTimeline } from "@/components/payroll/PayslipEventsTimeline";
import { PayslipCorrectionBanner } from "@/components/payroll/PayslipCorrectionBanner";

interface PayslipSummary {
  gross_pay?: number | null;
  total_deductions?: number | null;
  net_pay?: number | null;
  payroll_run?: {
    payroll_number?: string | null;
    pay_period_start?: string | null;
    pay_period_end?: string | null;
  } | null;
}

interface Props {
  payslipId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canSeeAmounts?: boolean;
  currency?: string;
  title?: string;
  description?: string;
  /** Optional payslip summary for the header cards. Required for portal mode. */
  payslip?: PayslipSummary | null;
  /**
   * Portal/self-service mode: hide the Employer column and employer
   * sub-breakdowns in line explainers. Default false (admin).
   */
  portalMode?: boolean;
  /**
   * Container variant. "dialog" (default) keeps the admin drill-down modal;
   * "sheet" opens as a right-side DetailSheet — the pattern the ESS portal
   * (/me/*) uses everywhere else.
   */
  variant?: "dialog" | "sheet";
}

function fmt(n: number | null | undefined, currency?: string, hide?: boolean) {
  if (hide) return "•••";
  const v = Number(n ?? 0);
  const s = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
}

function fmtDate(d?: string | null) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return d;
  }
}

export function PayslipDetailDialog({
  payslipId,
  open,
  onOpenChange,
  canSeeAmounts = true,
  currency,
  title = "Payslip detail",
  description,
  payslip,
  portalMode = false,
  variant = "dialog",
}: Props) {
  const { data: lines = [], isLoading } = usePayslipLines(open && payslipId ? payslipId : undefined);
  const { data: header } = usePayslipHeader(open && payslipId ? payslipId : undefined);
  const hide = !canSeeAmounts;

  // Bucket lines via the SHARED classifier (mirror of the PDF generator).
  // Substring heuristics on category strings were the original drift bug:
  // a negative earning (clawback) silently flipped to "Deductions".
  const grouped = useMemo(() => {
    const earnings: any[] = [];
    const deductions: any[] = [];
    const employer: any[] = [];
    for (const l of lines as any[]) {
      const bucket = classifyPayslipLine(l);
      if (bucket === "earning") earnings.push(l);
      else if (bucket === "deduction") deductions.push(l);
      else if (bucket === "employer_contribution") employer.push(l);
      // 'info' lines are intentionally dropped from the totals view.
    }
    return { earnings, deductions, employer };
  }, [lines]);

  const defaultDescription = portalMode
    ? "Your earnings and deductions for this pay period."
    : "Line-by-line breakdown — click the info icon on any row to see how it was calculated.";

  const periodLabel =
    payslip?.payroll_run?.pay_period_start && payslip?.payroll_run?.pay_period_end
      ? `${fmtDate(payslip.payroll_run.pay_period_start)} – ${fmtDate(payslip.payroll_run.pay_period_end)}`
      : payslip?.payroll_run?.payroll_number ?? "";

  const body = (
    <>
      {/* Phase 4 P3 — correction-link banner (superseded / corrects). */}
      {payslipId && <PayslipCorrectionBanner payslipId={payslipId} />}

      {/* Localization-aware employer / employee / statutory-ID header */}
      {header && <PayslipHeader header={header} portalMode={portalMode} />}

      {/* Summary header — visible whenever payslip totals are provided */}
      {payslip && (
        <div className="grid gap-3 grid-cols-3">
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-xs text-muted-foreground font-normal">Gross earnings</CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0">
              <p className="text-xl font-bold tabular-nums">{fmt(payslip.gross_pay, currency, hide)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-xs text-muted-foreground font-normal">Deductions</CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0">
              <p className="text-xl font-bold tabular-nums text-destructive">
                {fmt(payslip.total_deductions, currency, hide)}
              </p>
            </CardContent>
          </Card>
          <Card className="border-primary/30 bg-primary/[0.03]">
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-xs text-muted-foreground font-normal">Net pay</CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0">
              <p className="text-xl font-bold tabular-nums text-primary">{fmt(payslip.net_pay, currency, hide)}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">
          No line detail available for this payslip.
        </p>
      ) : portalMode ? (
        <div className="space-y-4">
          <Section
            title="Earnings"
            rows={grouped.earnings}
            currency={currency}
            hide={hide}
            hideEmployer
            amountKey="employee_amount"
            accent="text-foreground"
            employeeId={header?.employee?.id}
          />
          <Section
            title="Deductions"
            rows={[...grouped.deductions]}
            currency={currency}
            hide={hide}
            hideEmployer
            amountKey="employee_amount"
            accent="text-destructive"
            negate
            employeeId={header?.employee?.id}
          />
          {payslip && (
            <>
              <Separator />
              <div className="flex items-center justify-between px-1">
                <span className="text-sm font-medium">Net pay</span>
                <span className="text-lg font-bold tabular-nums text-primary">
                  {fmt(payslip.net_pay, currency, hide)}
                </span>
              </div>
            </>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Employee</TableHead>
              <TableHead className="text-right">Employer</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(lines as any[]).map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-mono text-xs">{l.rule_code}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    {l.label}
                    <PayslipLineExplainer line={l} hideAmounts={hide} currency={currency} employeeId={header?.employee?.id} />
                  </span>
                </TableCell>
                <TableCell>
                  {l.category && <Badge variant="outline" className="text-[10px]">{l.category}</Badge>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmt(l.employee_amount, currency, hide)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(l.employer_amount, currency, hide)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {!portalMode && payslipId && (
        <div className="mt-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            History
          </h4>
          <PayslipEventsTimeline payslipId={payslipId} />
        </div>
      )}
    </>
  );

  const combinedDescription = (
    <>
      {description ?? defaultDescription}
      {periodLabel ? <span className="ml-1 text-foreground/80">· {periodLabel}</span> : null}
    </>
  );

  const headerActions =
    !portalMode && payslipId ? (
      <ReprintButton
        kind="receipt"
        documentKind="payslip"
        sourceDocType="payslip"
        sourceDocId={payslipId}
        documentNumber={payslip?.payroll_run?.payroll_number ?? undefined}
        receiptData={{ kind: "payslip", payslipId }}
      />
    ) : null;

  if (variant === "sheet") {
    return (
      <DetailSheet
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={combinedDescription}
        headerActions={headerActions}
        size="lg"
      >
        <div className="flex flex-col gap-4 px-6 py-4">{body}</div>
      </DetailSheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{combinedDescription}</DialogDescription>
            </div>
            {headerActions}
          </div>
        </DialogHeader>
        <div className="flex flex-col gap-4">{body}</div>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  rows,
  currency,
  hide,
  hideEmployer,
  amountKey,
  accent,
  negate,
  employeeId,
}: {
  title: string;
  rows: any[];
  currency?: string;
  hide?: boolean;
  hideEmployer?: boolean;
  amountKey: "employee_amount" | "employer_amount";
  accent?: string;
  negate?: boolean;
  employeeId?: string | null;
}) {
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + Number(r[amountKey] ?? 0), 0);
  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-2 border-b bg-muted/30">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      </div>
      <div className="divide-y">
        {rows.map((l) => {
          const amt = Number(l[amountKey] ?? 0);
          return (
            <div key={l.id} className="flex items-center justify-between px-4 py-2.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm truncate">{l.label}</span>
                <PayslipLineExplainer line={l} hideAmounts={hide} currency={currency} hideEmployer={hideEmployer} employeeId={employeeId} />
              </div>
              <span className={`text-sm font-medium tabular-nums ${accent ?? ""}`}>
                {negate ? "(" : ""}
                {fmt(amt, currency, hide)}
                {negate ? ")" : ""}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between px-4 py-2 border-t bg-muted/20">
        <span className="text-xs font-medium text-muted-foreground">Total {title.toLowerCase()}</span>
        <span className={`text-sm font-bold tabular-nums ${accent ?? ""}`}>
          {negate ? "(" : ""}
          {fmt(total, currency, hide)}
          {negate ? ")" : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * BreakdownTable — single source of truth for rendering a per-band /
 * per-component payroll breakdown. Used by both:
 *
 *   - `RuleSimulator` (authoring-time preview of a statutory rule)
 *   - `PayslipLineExplainer` (runtime "Why was this deducted?" popover
 *     reading `payslip_lines.source.bracket_breakdown`).
 *
 * Sharing prevents the simulator's math/labels and the production
 * payslip explanation from drifting visually.
 */
import { Sparkles } from "lucide-react";

export interface BreakdownRowView {
  label: string;
  amount: number;
  /** Optional rate (0..1 fraction) — rendered as a percent chip. */
  rate?: number;
  /** Optional base amount the rate was applied against. */
  base?: number;
}

export interface BreakdownBlockProps {
  title: string;
  rows: BreakdownRowView[];
  total: number;
  currency?: string;
}

function fmtAmount(n: number, currency?: string) {
  const s = (Number.isFinite(n) ? n : 0).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${s}` : s;
}

function fmtPct(rate?: number) {
  if (rate == null || !Number.isFinite(rate)) return null;
  // Allow callers to pass either fraction (0.3) or already-percent (30).
  const v = rate > 1 ? rate : rate * 100;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

export function BreakdownBlock({ title, rows, total, currency }: BreakdownBlockProps) {
  return (
    <div>
      <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
        {title}
      </div>
      <div className="space-y-1">
        {rows.map((r, i) => {
          const pct = fmtPct(r.rate);
          return (
            <div key={i} className="flex justify-between text-xs gap-3">
              <span className="text-muted-foreground truncate">
                {r.label}
                {pct && <span className="ml-1 text-[10px] opacity-70">({pct})</span>}
              </span>
              <span className="font-mono shrink-0">{fmtAmount(r.amount, currency)}</span>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-sm font-medium mt-2 pt-1 border-t">
        <span>{title} total</span>
        <span className="font-mono">{fmtAmount(total, currency)}</span>
      </div>
    </div>
  );
}

export interface BreakdownTableProps {
  employeeRows?: BreakdownRowView[];
  employerRows?: BreakdownRowView[];
  employeeTotal?: number;
  employerTotal?: number;
  explanation?: string[];
  currency?: string;
}

/**
 * Composite renderer: employee block + employer block + plain-language
 * explanation footer. Blocks render only when their row arrays are
 * non-empty so it adapts to "employee-only" rules (PAYE) and
 * "split contribution" rules (NSSF / pension) alike.
 */
export function BreakdownTable({
  employeeRows = [],
  employerRows = [],
  employeeTotal = 0,
  employerTotal = 0,
  explanation = [],
  currency,
}: BreakdownTableProps) {
  const hasAny = employeeRows.length > 0 || employerRows.length > 0;
  if (!hasAny && explanation.length === 0) return null;
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3">
      {employeeRows.length > 0 && (
        <BreakdownBlock
          title="Employee"
          rows={employeeRows}
          total={employeeTotal}
          currency={currency}
        />
      )}
      {employerRows.length > 0 && (
        <BreakdownBlock
          title="Employer"
          rows={employerRows}
          total={employerTotal}
          currency={currency}
        />
      )}
      {explanation.length > 0 && (
        <div className="text-xs text-muted-foreground border-t pt-2 flex gap-2">
          <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
          <div className="space-y-1">
            {explanation.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
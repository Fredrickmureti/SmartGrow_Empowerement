/**
 * Payroll period lifecycle — single source of truth for UI eligibility.
 * Mirrors the enum + transition matrix in `payroll_period_transition`.
 * Components MUST use these helpers instead of comparing `status === "open"`
 * so a new lifecycle state doesn't silently regress the UI.
 */
export type PayrollPeriodStatus =
  | "open"
  | "preparing"
  | "processing"
  | "awaiting_approval"
  | "posted"
  | "paid"
  | "closed"
  | "reopened"
  | "cancelled"
  | "archived";

export interface PayrollPeriodLike {
  status?: string | null;
}

const CLOSEABLE = new Set<PayrollPeriodStatus>([
  "open",
  "preparing",
  "processing",
  "awaiting_approval",
  "posted",
  "paid",
  "reopened",
]);

const REOPENABLE = new Set<PayrollPeriodStatus>(["closed"]);
const TERMINAL = new Set<PayrollPeriodStatus>(["archived", "cancelled"]);

export function getPeriodLifecycle(p: PayrollPeriodLike): PayrollPeriodStatus {
  return (p.status ?? "open") as PayrollPeriodStatus;
}

export function canClosePeriod(p: PayrollPeriodLike): boolean {
  return CLOSEABLE.has(getPeriodLifecycle(p));
}

export function canReopenPeriod(p: PayrollPeriodLike): boolean {
  return REOPENABLE.has(getPeriodLifecycle(p));
}

export function isTerminalPeriod(p: PayrollPeriodLike): boolean {
  return TERMINAL.has(getPeriodLifecycle(p));
}

export function periodStatusBadgeVariant(
  status: PayrollPeriodStatus,
): "default" | "outline" | "secondary" | "destructive" {
  switch (status) {
    case "closed":
    case "paid":
    case "archived":
      return "secondary";
    case "cancelled":
      return "destructive";
    case "awaiting_approval":
    case "processing":
    case "posted":
      return "default";
    default:
      return "outline";
  }
}
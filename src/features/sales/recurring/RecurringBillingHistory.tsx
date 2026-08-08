/**
 * RecurringBillingHistory — the audit surface for a recurring template.
 *
 * Reads `recurring_invoice_runs` and shows one row per billing period with
 * its outcome, so an operator can see what was billed, what failed and why,
 * and whether the invoice reached the customer.
 */
import { format } from "date-fns";
import { EmptyState, Section, StatusBadge } from "@/design-system";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRecurringInvoiceRuns, type RecurringInvoiceRun } from "./useRecurringInvoiceRuns";

const fmt = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

function statusTone(status: RecurringInvoiceRun["status"]) {
  switch (status) {
    case "posted":
      return "success" as const;
    case "generated":
      return "info" as const;
    case "failed":
      return "danger" as const;
    case "skipped":
      return "neutral" as const;
    default:
      return "warning" as const;
  }
}

function statusLabel(status: RecurringInvoiceRun["status"]) {
  switch (status) {
    case "posted":
      return "Invoiced & posted";
    case "generated":
      return "Invoiced (draft)";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    default:
      return "In progress";
  }
}

function deliveryLabel(run: RecurringInvoiceRun) {
  switch (run.delivery_status) {
    case "sent":
      return `Sent ${fmt(run.delivered_at)}`;
    case "pending":
      return "Queued for sending";
    case "queued":
      return "Queued for sending";
    case "failed":
      return `Delivery failed: ${run.delivery_error ?? "unknown error"}`;
    default:
      return "Not sent";
  }
}

export function RecurringBillingHistory({ recurringId }: { recurringId: string | null }) {
  const { data: runs = [], isLoading } = useRecurringInvoiceRuns(recurringId);

  return (
    <Section title="Billing history" description="One row per billing period, including failures.">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading billing history…</p>
      ) : runs.length === 0 ? (
        <EmptyState
          title="No billing periods yet"
          description="Each time this schedule falls due, the outcome is recorded here."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Billing period</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Delivery</TableHead>
              <TableHead>Trigger</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="whitespace-nowrap">
                  {fmt(run.period_start)} — {fmt(run.period_end)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <StatusBadge tone={statusTone(run.status)}>{statusLabel(run.status)}</StatusBadge>
                    {run.failure_reason && (
                      <span className="text-xs text-muted-foreground">{run.failure_reason}</span>
                    )}
                    {run.attempt_count > 1 && (
                      <span className="text-xs text-muted-foreground">
                        {run.attempt_count} attempts
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="tabular-nums">{run.invoice_number ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{deliveryLabel(run)}</TableCell>
                <TableCell className="text-sm text-muted-foreground capitalize">
                  {run.trigger_source}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

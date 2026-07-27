/**
 * JobDetailDrawer — progressive disclosure for a single print_jobs row.
 *
 * The Print activity table shows business identity only. Everything
 * technical (correlation id, hw_command_id, raw error, retry timeline)
 * lives here so operators are not overwhelmed but support engineers can
 * still get to the truth in one click.
 */
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import {
  docTypeLabel,
  intentLabel,
  formatLabel,
  transportLabel,
  statusLabel,
  statusTone,
  durationLabel,
  shortDateTime,
  classifyError,
} from "../lib/humanize";
import type { DisplayLabel } from "../hooks/useHardwareDisplay";

export interface PrintJobDrawerRow {
  id: string;
  doc_type: string;
  doc_id: string | null;
  intent: string;
  format: string;
  transport: string | null;
  status: string;
  correlation_id: string | null;
  parent_job_id: string | null;
  attempt_count: number | null;
  last_error: string | null;
  requested_at: string;
  sent_at: string | null;
  acked_at: string | null;
  failed_at: string | null;
  requested_by: string | null;
  printer_profile_id: string | null;
}

interface Props {
  row: PrintJobRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentLabel: DisplayLabel;
  requesterLabel: DisplayLabel;
  printerLabel: DisplayLabel;
}

type PrintJobRow = PrintJobDrawerRow;

function copy(text: string, note: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${note} copied`),
    () => toast.error("Copy failed"),
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-start gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function JobDetailDrawer({
  row,
  open,
  onOpenChange,
  documentLabel,
  requesterLabel,
  printerLabel,
}: Props) {
  if (!row) return null;
  const terminalAt = row.acked_at ?? row.failed_at ?? row.sent_at;
  const err = row.last_error ? classifyError(row.last_error) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {documentLabel.label}
            <Badge variant={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
          </SheetTitle>
          <SheetDescription>
            {docTypeLabel(row.doc_type)} · {intentLabel(row.intent)} · Requested {shortDateTime(row.requested_at)}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <section>
            <h3 className="text-sm font-medium mb-1">Overview</h3>
            <Field label="Document">{documentLabel.label}</Field>
            <Field label="Requested by">{requesterLabel.label}</Field>
            <Field label="Destination">
              <div className="flex flex-col">
                <span>{printerLabel.label}</span>
                {printerLabel.secondary && (
                  <span className="text-xs text-muted-foreground">{printerLabel.secondary}</span>
                )}
              </div>
            </Field>
            <Field label="Intent">{intentLabel(row.intent)}</Field>
            <Field label="Format">{formatLabel(row.format)}</Field>
            <Field label="Transport">{transportLabel(row.transport)}</Field>
          </section>

          <Separator />

          <section>
            <h3 className="text-sm font-medium mb-1">Timeline</h3>
            <Field label="Requested">{shortDateTime(row.requested_at)}</Field>
            <Field label="Sent to printer">{shortDateTime(row.sent_at)}</Field>
            <Field label="Printed">{shortDateTime(row.acked_at)}</Field>
            <Field label="Failed">{shortDateTime(row.failed_at)}</Field>
            <Field label="Total time">{durationLabel(row.requested_at, terminalAt)}</Field>
            <Field label="Attempts">{row.attempt_count ?? 1}</Field>
          </section>

          {err && (
            <>
              <Separator />
              <section>
                <h3 className="text-sm font-medium mb-1 text-destructive">Error</h3>
                <Field label="Summary">{err.summary}</Field>
                <Field label="Category">
                  <Badge variant="outline">{err.category}</Badge>
                </Field>
                <Field label="What to do">{err.hint}</Field>
                <div className="mt-2 rounded border bg-muted/40 p-2 text-xs font-mono whitespace-pre-wrap max-h-40 overflow-auto">
                  {row.last_error}
                </div>
                <div className="mt-2">
                  <Button size="sm" variant="outline" onClick={() => copy(row.last_error!, "Error")}>
                    <Copy className="h-3 w-3 mr-1" /> Copy error
                  </Button>
                </div>
              </section>
            </>
          )}

          <Separator />

          <section>
            <h3 className="text-sm font-medium mb-1">Support identifiers</h3>
            <Field label="Job id">
              <button
                className="font-mono text-xs hover:underline"
                onClick={() => copy(row.id, "Job id")}
                title="Click to copy"
              >
                {row.id}
              </button>
            </Field>
            {row.correlation_id && (
              <Field label="Correlation">
                <button
                  className="font-mono text-xs hover:underline"
                  onClick={() => copy(row.correlation_id!, "Correlation id")}
                  title="Click to copy"
                >
                  {row.correlation_id}
                </button>
              </Field>
            )}
            {row.parent_job_id && (
              <Field label="Parent job">
                <span className="font-mono text-xs">{row.parent_job_id}</span>
              </Field>
            )}
            {row.doc_id && (
              <Field label="Document id">
                <span className="font-mono text-xs">{row.doc_id}</span>
              </Field>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
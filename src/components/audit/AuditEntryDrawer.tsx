/**
 * AuditEntryDrawer — shared right-hand drawer for every audit-log surface.
 *
 * Wraps `DetailSheet` with the standard summary strip + Copy ID / Copy JSON
 * header actions used by the Activity tab, and exposes a `children` slot so
 * each caller can render its own body (field diff, details grid, timeline
 * detail, etc.).
 *
 * Always mounted; `open` is bound to `!!entry` to satisfy the Radix overlay
 * rules in docs/architecture/OVERLAYS.md.
 */
import { format } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { DetailSheet, StatusBadge } from "@/design-system";
import type { AuditEntry } from "./AuditLogTableView";

interface DrawerSummaryField {
  label: string;
  value: React.ReactNode;
}

interface Props {
  entry: AuditEntry | null;
  onClose: () => void;
  title?: string;
  description?: string;
  /** Extra rows appended to the summary strip. */
  extraSummary?: DrawerSummaryField[];
  /** JSON payload used by the Copy JSON button and the "Raw payload" details block. */
  rawJson?: unknown;
  /** Optional record ID used by the Copy ID button (defaults to entry.id). */
  copyId?: string;
  children?: React.ReactNode;
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Copy failed");
  }
}

export function AuditEntryDrawer({
  entry,
  onClose,
  title,
  description,
  extraSummary,
  rawJson,
  copyId,
  children,
}: Props) {
  return (
    <DetailSheet
      open={!!entry}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      title={title ?? entry?.summary ?? "Audit entry"}
      description={
        description ??
        (entry ? format(new Date(entry.occurredAt), "MMMM d, yyyy 'at' HH:mm:ss") : undefined)
      }
      headerActions={
        entry && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(copyId ?? entry.id, "Log ID")}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              ID
            </Button>
            {rawJson !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  copyToClipboard(JSON.stringify(rawJson, null, 2), "JSON")
                }
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                JSON
              </Button>
            )}
          </>
        )
      }
    >
      {entry && (
        <div className="space-y-6">
          {/* Summary strip — identical shape across every audit surface */}
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryItem label="Action">
              <StatusBadge tone={entry.action.tone}>{entry.action.label}</StatusBadge>
            </SummaryItem>
            <SummaryItem label="Entity">{entry.entity.label}</SummaryItem>
            {entry.entityName && (
              <SummaryItem label="Record">{entry.entityName}</SummaryItem>
            )}
            <SummaryItem label="User">{entry.userLabel || "System"}</SummaryItem>
            {extraSummary?.map((f) => (
              <SummaryItem key={f.label} label={f.label}>
                {f.value}
              </SummaryItem>
            ))}
          </div>

          {children}

          {rawJson !== undefined && (
            <details className="rounded-md border bg-muted/30">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                Raw payload (for engineers)
              </summary>
              <pre className="px-3 py-2 text-xs overflow-x-auto">
                {JSON.stringify(rawJson, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </DetailSheet>
  );
}

export function SummaryItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-0.5">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

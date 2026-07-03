/**
 * RFQPeekSheet — standard peek surface for one RFQ.
 * Row-click on the RFQs list opens this sheet with `?peek=<id>`.
 * "Open full page" is provided by DocumentPeekShell.
 */
import { Link } from "react-router-dom";
import { Pencil } from "lucide-react";
import { format } from "date-fns";
import {
  StatusBadge,
  DocumentPeekShell,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { useRFQRecord } from "./useRFQRecord";
import { RFQRecordBody } from "./RFQRecordBody";

const TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  sent: "info",
  received: "warning",
  closed: "success",
  cancelled: "danger",
};

const label = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

interface Props {
  rfqId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function RFQPeekSheet({ rfqId, onOpenChange }: Props) {
  const { record, loading, error } = useRFQRecord(rfqId);

  return (
    <DocumentPeekShell
      open={!!rfqId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load RFQ"
      fullPageHref={record ? `/purchases/rfqs/${record.id}` : undefined}
      extraHeaderActions={
        record && record.status === "draft" ? (
          <Button asChild size="sm" variant="outline">
            <Link
              to={`/purchases/rfqs/${record.id}/edit`}
              onClick={() => onOpenChange(false)}
            >
              <Pencil className="mr-1.5 h-4 w-4" /> Edit
            </Link>
          </Button>
        ) : undefined
      }
      title={
        loading
          ? "Loading RFQ…"
          : record
            ? `RFQ ${record.rfq_number}`
            : "RFQ"
      }
      description={
        record ? (
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={TONE[record.status] ?? "neutral"}>
              {label(record.status)}
            </StatusBadge>
            {record.deadline && (
              <span className="text-muted-foreground">
                Due {(() => {
                  try {
                    return format(new Date(record.deadline), "PP");
                  } catch {
                    return record.deadline;
                  }
                })()}
              </span>
            )}
          </span>
        ) : undefined
      }
    >
      {record && (
        <div className="space-y-5">
          <RFQRecordBody record={record} />
        </div>
      )}
    </DocumentPeekShell>
  );
}

export default RFQPeekSheet;
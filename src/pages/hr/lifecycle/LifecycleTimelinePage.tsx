/**
 * Lifecycle Timeline — the cross-employee "All events" log.
 *
 * First real screen of the Lifecycle sub-app: filterable by event type
 * and time window, drills into the employee profile. Consumes
 * employee_lifecycle_events via useLifecycleEvents.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow, format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, History, Filter, ExternalLink, Printer } from "lucide-react";
import { PageHeader, PageBody } from "@/design-system";
import {
  useLifecycleEvents,
  LIFECYCLE_EVENT_LABELS,
  lifecycleEventTone,
  type LifecycleEventType,
} from "@/hooks/hr/useLifecycleEvents";
import { usePrintOrPreview } from "@/hooks/usePrintOrPreview";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { DocumentHistorySheet } from "@/components/documents/DocumentHistorySheet";

/**
 * Map a lifecycle event_type to the HR letter document type served by
 * generate-document. Events that don't produce a formal letter return null.
 */
function letterTypeFor(eventType: string): "promotion_letter" | "warning_letter" | null {
  if (eventType === "promoted") return "promotion_letter";
  if (eventType === "warning_issued") return "warning_letter";
  return null;
}

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last 12 months", days: 365 },
];

export default function LifecycleTimelinePage() {
  const navigate = useNavigate();
  const [windowDays, setWindowDays] = useState<number>(30);
  const [eventType, setEventType] = useState<LifecycleEventType | "all">("all");
  const [search, setSearch] = useState("");
  const {
    printPreviewOpen,
    setPrintPreviewOpen,
    printPreviewTitle,
    printDocumentType,
    printDocumentId,
    printCommunication,
    generateDocument,
  } = usePrintOrPreview();

  const { events, isLoading } = useLifecycleEvents({
    sinceDays: windowDays,
    eventTypes: eventType === "all" ? undefined : [eventType],
    limit: 500,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (e) =>
        (e.employee_name ?? "").toLowerCase().includes(q) ||
        (e.employee_number ?? "").toLowerCase().includes(q) ||
        (e.summary ?? "").toLowerCase().includes(q) ||
        (e.actor_label ?? "").toLowerCase().includes(q),
    );
  }, [events, search]);

  return (
    <>
      <PageHeader
        eyebrow="HR · Lifecycle"
        title="All lifecycle events"
        description="Every recorded transition in the employee lifecycle, across the whole organization."
      />
      <PageBody fullWidth className="gap-4 sm:gap-6">
        <Card>
          <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v))}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w.days} value={String(w.days)}>{w.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={eventType} onValueChange={(v) => setEventType(v as any)}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All event types</SelectItem>
                  {Object.entries(LIFECYCLE_EVENT_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employee, actor, or summary…"
              className="sm:max-w-xs"
            />
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center space-y-2">
              <History className="h-8 w-8 text-muted-foreground mx-auto" />
              <div className="text-sm font-medium">No lifecycle events in this window</div>
              <p className="text-xs text-muted-foreground">
                Adjust the time range or event filter, or trigger a hire, transfer, or termination.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {filtered.map((e) => (
                  <li key={e.id} className="flex items-start gap-3 p-4 hover:bg-muted/40">
                    <div className="mt-0.5 shrink-0">
                      <Badge variant={lifecycleEventTone(e.event_type)}>
                        {LIFECYCLE_EVENT_LABELS[e.event_type] ?? e.event_type}
                      </Badge>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-medium truncate">
                          {e.employee_name ?? "Unknown employee"}
                        </span>
                        {e.employee_number && (
                          <span className="text-xs text-muted-foreground">
                            #{e.employee_number}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          · {formatDistanceToNow(new Date(e.occurred_at), { addSuffix: true })}
                          {e.effective_date ? ` · effective ${format(new Date(e.effective_date), "MMM d, yyyy")}` : ""}
                        </span>
                      </div>
                      {e.summary && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {e.summary}
                        </p>
                      )}
                      {e.actor_label && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          by {e.actor_label}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {(() => {
                        const lt = letterTypeFor(e.event_type);
                        if (!lt) return null;
                        const label = lt === "promotion_letter" ? "Promotion letter" : "Warning letter";
                        return (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                generateDocument(
                                  lt,
                                  e.id,
                                  `${label} — ${e.employee_name ?? ""}`.trim(),
                                )
                              }
                              title={`Print ${label.toLowerCase()}`}
                            >
                              <Printer className="mr-1 h-3.5 w-3.5" />
                              Print
                            </Button>
                            <DocumentHistorySheet
                              documentType={lt}
                              documentId={e.id}
                              title={`${label} — ${e.employee_name ?? ""}`.trim()}
                            />
                          </>
                        );
                      })()}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigate(`/hr/employees/${e.employee_id}?section=history`)}
                        title="Open employee"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </PageBody>

      <PrintPreviewDialog
        open={printPreviewOpen}
        onOpenChange={setPrintPreviewOpen}
        title={printPreviewTitle}
        documentType={printDocumentType}
        documentId={printDocumentId}
        communication={printCommunication}
      />
    </>
  );
}

/**
 * TrailerVisitDrawer — the yard *preview* pane (ADR 0122).
 *
 * A board (Yard control tower, Gate console, Trailer register) peeks at a
 * visit: who it is, where it stands, how long it has been here, what is on
 * it, and what blocks it from leaving. Two one-click gate acts stay here
 * because they happen at the barrier with a driver waiting.
 *
 * Everything else — slot moves, dock assignment, departure clearance with
 * override, seals, the movement ledger and the custody chain — lives on the
 * visit workspace (`/warehouse-app/yard/visit/:id`), because a state machine
 * with audit trails is not a side-pane job.
 */
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/design-system";
import { AlertTriangle, Printer, ShieldCheck, XCircle } from "lucide-react";
import { format } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";
import {
  EntityPreview,
  PreviewFact,
} from "@/features/warehouse/entity/EntityPreview";
import {
  blockerLabel,
  dwellMinutes,
  formatDwell,
  receivingProgressPct,
  VISIT_STATUS_LABEL,
  type VisitRow,
} from "./yardModel";
import {
  useDepartureBlockers,
  useGateApprove,
  useMarkNoShow,
  useTrailerLoadSummaries,
} from "./useYard";
import { printTrailerPlacard } from "./yardLabels";
import { useOrganization } from "@/hooks/useOrganization";

function ts(v: string | null | undefined) {
  return v ? format(new Date(v), "dd MMM HH:mm") : "—";
}

export function trailerVisitWorkspaceHref(id: string) {
  return `/warehouse-app/yard/visit/${id}`;
}

export function TrailerVisitDrawer({
  visit,
  onClose,
}: {
  visit: VisitRow | null;
  /** Accepted for call-site compatibility; the workspace owns these. */
  slots?: unknown;
  docks?: unknown;
  openMoveTask?: unknown;
  onClose: () => void;
}) {
  const [printing, setPrinting] = useState(false);
  const { currentOrg } = useOrganization();
  const loadSummaries = useTrailerLoadSummaries(visit?.warehouse_id ?? null);
  const loadSummary = visit ? loadSummaries.data?.get(visit.id) ?? null : null;
  const blockers = useDepartureBlockers(
    visit && visit.status !== "departed" && visit.status !== "no_show" ? visit.id : null,
  );
  const approveGate = useGateApprove();
  const noShow = useMarkNoShow();

  if (!visit) return null;

  const blocking = blockers.data ?? [];
  const pct = loadSummary ? receivingProgressPct(loadSummary) : null;

  async function printPlacard() {
    if (!visit) return;
    if (!currentOrg?.id) {
      toast.error("No active organization");
      return;
    }
    setPrinting(true);
    try {
      const res = await printTrailerPlacard({ orgId: currentOrg.id, visit });
      if (res.success) toast.success("Placard sent to the printer");
      else toast.error(res.error ?? "Could not print the placard");
    } finally {
      setPrinting(false);
    }
  }

  return (
    <Sheet open={!!visit} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full p-0 sm:max-w-md">
        <EntityPreview
          eyebrow="Yard visit"
          title={visit.trailer_ref}
          subtitle={`${visit.carrier?.name ?? "Walk-in"} · driver ${visit.driver_name || "unknown"}`}
          status={
            <div className="flex flex-col items-end gap-1">
              <StatusBadge tone={visit.status === "departed" ? "neutral" : "info"}>
                {VISIT_STATUS_LABEL[visit.status]}
              </StatusBadge>
              {visit.departure_approved_at && <Badge variant="outline">Cleared</Badge>}
            </div>
          }
          metrics={[
            { label: "Dwell", value: formatDwell(dwellMinutes(visit)) },
            {
              label: "Blocking work",
              value: String(blocking.length),
              tone: blocking.length ? "danger" : "default",
            },
          ]}
          workspaceHref={trailerVisitWorkspaceHref(visit.id)}
          workspaceLabel="Open visit workspace"
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={printing}
                onClick={() => void printPlacard()}
              >
                <Printer className="h-3.5 w-3.5" /> Placard
              </Button>
              {visit.status === "arrived" && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={approveGate.isPending}
                    onClick={() => approveGate.mutate({ visitId: visit.id, approved: true })}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Security clear
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-destructive"
                    disabled={noShow.isPending}
                    onClick={() => noShow.mutate({ visitId: visit.id })}
                  >
                    <XCircle className="h-3.5 w-3.5" /> No-show
                  </Button>
                </>
              )}
            </>
          }
        >
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Position</h3>
            <PreviewFact label="Arrived" value={ts(visit.arrived_at)} />
            <PreviewFact label="Yard slot" value={visit.slot?.code ?? "—"} />
            <PreviewFact label="Dock" value={visit.dock?.name || visit.dock?.code || "—"} />
            <PreviewFact
              label="Seal in / out"
              value={`${visit.seal_in || "—"} / ${visit.seal_out || "—"}`}
            />
            <PreviewFact
              label="Appointment"
              value={
                visit.appointment
                  ? `${visit.appointment.appointment_no ?? visit.appointment.appointment_type} · ${format(
                      new Date(visit.appointment.window_start),
                      "HH:mm",
                    )}–${format(new Date(visit.appointment.window_end), "HH:mm")}`
                  : "Walk-in"
              }
            />
          </section>

          {loadSummary && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Load</h3>
              <PreviewFact
                label="Outbound"
                value={`${loadSummary.manifest_count} manifest(s) · ${loadSummary.carton_count} carton(s)`}
              />
              <PreviewFact
                label="Inbound"
                value={`${loadSummary.receiving_session_count} session(s)${
                  pct !== null ? ` · ${pct}% received` : ""
                }`}
              />
            </section>
          )}

          {blocking.length > 0 && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
                <AlertTriangle className="h-4 w-4" /> Blocks departure
              </h3>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {blocking.map((b) => (
                  <li key={`${b.kind}:${b.id}`}>{blockerLabel(b)}</li>
                ))}
              </ul>
            </section>
          )}
        </EntityPreview>
      </SheetContent>
    </Sheet>
  );
}

export default TrailerVisitDrawer;

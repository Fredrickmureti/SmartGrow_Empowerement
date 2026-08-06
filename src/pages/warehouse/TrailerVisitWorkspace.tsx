/**
 * TrailerVisitWorkspace — the management workspace for one yard visit
 * (ADR 0122).
 *
 * The gate/yard boards preview a visit; the state machine (slot moves,
 * dock assignment, departure clearance, seals) and the two audit trails
 * get a full-width object page.
 */
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { ErrorState, LoadingState, Section, StatusBadge } from "@/design-system";
import { EntityWorkspaceShell } from "@/features/warehouse/entity/EntityWorkspaceShell";
import { TrailerVisitBody } from "@/features/warehouse/yard/TrailerVisitBody";
import {
  useDockDoors,
  useOpenYardMoveTasks,
  useYardSlots,
  useYardVisits,
} from "@/features/warehouse/yard/useYard";
import {
  VISIT_STATUS_LABEL,
  dwellMinutes,
  formatDwell,
} from "@/features/warehouse/yard/yardModel";

const BOARD_PATH = "/warehouse-app/yard";

export default function TrailerVisitWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const visits = useYardVisits(null);
  const visit = useMemo(
    () => (visits.data ?? []).find((v) => v.id === id) ?? null,
    [visits.data, id],
  );

  const slots = useYardSlots(visit?.warehouse_id ?? null);
  const docks = useDockDoors(visit?.warehouse_id ?? null);
  const openTasks = useOpenYardMoveTasks(visit?.warehouse_id ?? null);
  const openMoveTask = useMemo(
    () => (openTasks.data ?? []).find((t) => t.visit_id === id) ?? null,
    [openTasks.data, id],
  );

  if (visits.isLoading) return <LoadingState />;
  if (!visit) {
    return (
      <ErrorState
        title="Trailer visit not found"
        description="It may have departed and been archived, or belongs to another warehouse."
        onRetry={() => navigate(BOARD_PATH)}
      />
    );
  }

  return (
    <EntityWorkspaceShell
      eyebrow="Yard visit"
      title={visit.trailer_ref}
      docNumber={visit.carrier?.name ?? "Walk-in"}
      backHref={BOARD_PATH}
      backLabel="Yard"
      status={
        <div className="flex flex-wrap gap-1">
          <StatusBadge tone={visit.status === "departed" ? "neutral" : "info"}>
            {VISIT_STATUS_LABEL[visit.status]}
          </StatusBadge>
          {visit.departure_approved_at && <Badge variant="outline">Cleared</Badge>}
        </div>
      }
      meta={
        <span className="text-xs text-muted-foreground">
          Driver {visit.driver_name || "unknown"} · dwell {formatDwell(dwellMinutes(visit))}
        </span>
      }
      tabs={[
        {
          value: "visit",
          label: "Visit",
          render: () => (
            <Section title="Execution">
              <TrailerVisitBody
                visit={visit}
                slots={slots.data ?? []}
                docks={docks.data ?? []}
                openMoveTask={openMoveTask}
              />
            </Section>
          ),
        },
      ]}
    />
  );
}

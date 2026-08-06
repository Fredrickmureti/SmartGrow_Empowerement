/**
 * LocationWorkspace — the management workspace for one physical position
 * (ADR 0122).
 *
 * The layout board previews a location; this route owns everything else:
 * what's in it, how it is configured, its label lifecycle. Future warehouse
 * capability (telemetry, capacity optimisation, automation, audit) attaches
 * as another tab here — never back into the side pane.
 */
import { useParams, useSearchParams } from "react-router-dom";
import { Ban, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, StatusBadge } from "@/design-system";
import { useBranches } from "@/hooks/useBranches";
import { EntityWorkspaceShell } from "@/features/warehouse/entity/EntityWorkspaceShell";
import { useLocationRecord } from "@/features/warehouse/locations/useLocationRecord";
import { useLocationMutations } from "@/features/warehouse/locations/useLocationMutations";
import { locationState } from "@/features/warehouse/locations/types";
import { levelLabel, STATE_COPY } from "@/features/warehouse/locations/vocabulary";
import LocationOverviewTab from "@/features/warehouse/locations/workspace/LocationOverviewTab";
import LocationConfigTab from "@/features/warehouse/locations/workspace/LocationConfigTab";
import LocationLabelTab from "@/features/warehouse/locations/workspace/LocationLabelTab";

export default function LocationWorkspace() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const { currentBranch } = useBranches();
  const { node, warehouseId, isLoading, notFound } = useLocationRecord(id);
  const { setActive } = useLocationMutations(warehouseId);

  const backHref = `/warehouse-app/layout${
    params.get("from") ? `?${params.get("from")}` : id ? `?sel=${id}` : ""
  }`;

  if (isLoading) return <LoadingState />;
  if (notFound || !node) {
    return (
      <ErrorState
        title="Location not found"
        description="It may have been retired, or you don't have access to its warehouse."
      />
    );
  }

  const state = locationState(node);

  return (
    <EntityWorkspaceShell
      eyebrow={levelLabel(node.structure_level)}
      title={node.code}
      docNumber={node.name && node.name !== node.code ? node.name : undefined}
      backHref={backHref}
      backLabel="Layout"
      status={
        <StatusBadge
          tone={state === "blocked" ? "danger" : state === "full" ? "warning" : "success"}
        >
          {STATE_COPY[state].label}
        </StatusBadge>
      }
      meta={
        <span className="text-xs text-muted-foreground">
          {node.path.slice(0, -1).join(" / ") || "Warehouse"}
        </span>
      }
      actions={
        <Button
          size="sm"
          variant={node.is_active ? "outline" : "default"}
          onClick={() => setActive.mutate({ id: node.id, active: !node.is_active })}
        >
          {node.is_active ? (
            <>
              <Ban className="mr-2 h-4 w-4" /> Block
            </>
          ) : (
            <>
              <RotateCcw className="mr-2 h-4 w-4" /> Return to service
            </>
          )}
        </Button>
      }
      tabs={[
        { value: "overview", label: "Overview", render: () => <LocationOverviewTab node={node} /> },
        {
          value: "configuration",
          label: "Configuration",
          render: () => <LocationConfigTab node={node} warehouseId={warehouseId} />,
        },
        {
          value: "label",
          label: "Label",
          render: () => (
            <LocationLabelTab
              node={node}
              warehouseId={warehouseId}
              branchId={currentBranch?.id ?? null}
            />
          ),
        },
      ]}
    />
  );
}

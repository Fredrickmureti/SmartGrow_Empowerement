/**
 * HandlingUnitPreview — the board-side peek at a license plate (ADR 0122).
 *
 * Handling units already own a workspace (the plate cockpit at
 * `/warehouse-app/plates/:id`); what the board lacked was the peek step, so
 * a supervisor had to leave the board to answer "what is on this pallet?".
 * Read-only by contract — building, sealing and moving happen in the
 * cockpit.
 */
import { StatusBadge } from "@/design-system";
import {
  EntityPreview,
  PreviewFact,
} from "@/features/warehouse/entity/EntityPreview";
import type { LpnOverviewRow } from "./useLpnOps";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  open: "warning",
  sealed: "success",
  shipped: "neutral",
  consumed: "neutral",
  cancelled: "danger",
};

export function HandlingUnitPreview({ row }: { row: LpnOverviewRow }) {
  return (
    <EntityPreview
      eyebrow="Handling unit"
      title={<span className="font-mono">{row.code}</span>}
      subtitle={row.location_path ?? row.location_code ?? "Unlocated"}
      status={
        <StatusBadge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</StatusBadge>
      }
      metrics={[
        {
          label: "Base units",
          value: `${Number(row.total_quantity ?? 0).toLocaleString()} across ${Number(row.sku_count ?? 0)} SKU${Number(row.sku_count ?? 0) === 1 ? "" : "s"}`,
        },
        { label: "SKUs", value: String(Number(row.sku_count ?? 0)) },
      ]}
      workspaceHref={`/warehouse-app/plates/${row.id}`}
      workspaceLabel="Open plate cockpit"
    >
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Summary</h3>
        <PreviewFact label="Type" value={<span className="capitalize">{row.lpn_type}</span>} />
        <PreviewFact label="Bin" value={row.location_code ?? "Unlocated"} />
        <PreviewFact label="Nested units" value={String(Number(row.child_count ?? 0))} />
        <PreviewFact label="Nested inside" value={row.parent_lpn_id ? "Yes" : "No"} />
        <PreviewFact label="Updated" value={new Date(row.updated_at).toLocaleString()} />
      </section>
    </EntityPreview>
  );
}

export default HandlingUnitPreview;

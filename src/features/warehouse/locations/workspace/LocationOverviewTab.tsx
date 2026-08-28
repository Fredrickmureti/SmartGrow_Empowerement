/**
 * LocationOverviewTab — what this position is and what is in it right now.
 * Read-only: quantity and value stay canonical in Inventory (ADR 0079).
 */
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/design-system";
import {
  SummaryStatCard,
  SummaryStatGrid,
} from "@/components/common/SummaryStatCards";
import { OccupancyBar } from "../OccupancyBar";
import { levelLabel } from "../vocabulary";
import type { LocationNode } from "../types";

export default function LocationOverviewTab({ node }: { node: LocationNode }) {
  const m = node.metrics;
  return (
    <>
      <Section title="What's here now" description="Rolled up from the stock ledger.">
        <SummaryStatGrid>
          <SummaryStatCard label="On hand" value={m.on_hand_units.toLocaleString()} />
          <SummaryStatCard label="Reserved" value={m.reserved_units.toLocaleString()} />
          <SummaryStatCard label="Products" value={m.sku_count.toLocaleString()} />
          <SummaryStatCard label="Lots" value={m.lot_count.toLocaleString()} />
        </SummaryStatGrid>
        <div className="space-y-1 pt-4">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Capacity used</span>
            <span>
              {m.occupancy_pct === null
                ? "No capacity set"
                : `${Math.round(m.occupancy_pct)}%`}
            </span>
          </div>
          <OccupancyBar pct={m.occupancy_pct} />
        </div>
      </Section>

      <Section title="Where it sits">
        <FieldGrid columns={3}>
          <FieldCell>
            <Fact label="Level" value={levelLabel(node.structure_level)} />
          </FieldCell>
          <FieldCell span={2}>
            <Fact label="Path" value={node.path.join(" / ")} />
          </FieldCell>
          <FieldCell>
            <Fact
              label="Contains"
              value={
                node.children.length
                  ? `${node.children.length.toLocaleString()} location${node.children.length === 1 ? "" : "s"}`
                  : "Nothing — this is a pickable position"
              }
            />
          </FieldCell>
          <FieldCell>
            <Fact label="Type" value={node.location_type || "—"} />
          </FieldCell>
          <FieldCell>
            <Fact label="Usage" value={node.usage || "—"} />
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section
        title="Open warehouse work"
        description="Tasks currently pointing at this position."
      >
        <div className="flex flex-wrap gap-2">
          {m.putaway_tasks > 0 && <Badge variant="secondary">{m.putaway_tasks} put-away</Badge>}
          {m.pick_tasks > 0 && <Badge variant="secondary">{m.pick_tasks} picks</Badge>}
          {m.count_tasks > 0 && <Badge variant="secondary">{m.count_tasks} counts</Badge>}
          {m.open_tasks === 0 && (
            <span className="text-sm text-muted-foreground">No open warehouse work.</span>
          )}
        </div>
        <p className="pt-3 text-sm text-muted-foreground">
          Follow work in{" "}
          <Link className="underline" to="/warehouse-app/tasks">
            My tasks
          </Link>{" "}
          or{" "}
          <Link className="underline" to="/warehouse-app/exceptions">
            Exceptions
          </Link>
          .
        </p>
      </Section>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="break-words text-sm">{value}</p>
    </div>
  );
}

/**
 * Warehouse Dashboard (Phase 0) — WMS overview.
 *
 * Shows warehouse master counts + a small KPI grid so users landing on
 * `/warehouse-app` have context for where the module is going. As WMS
 * domains (tasks, waves, docks, plates) come online in later phases,
 * their live KPIs replace the "coming online" tiles inline — no shell
 * changes needed. See ADR 0079.
 */
import { Link } from "react-router-dom";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  StatusBadge,
} from "@/design-system";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Warehouse as WarehouseIcon,
  Network,
  ClipboardList,
  Truck,
  PackageOpen,
  ShieldCheck,
  Tag,
} from "lucide-react";
import { useWarehouses } from "@/hooks/useWarehouses";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery } from "@tanstack/react-query";

interface RoadmapTile {
  title: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  phase: string;
  to?: string;
}

const ROADMAP: RoadmapTile[] = [
  { title: "Operator tasks", desc: "Universal work queue (pick / pack / load / count).", icon: ClipboardList, phase: "Phase 1", to: "/warehouse-app/tasks" },
  { title: "License plates", desc: "Pallet / carton / tote unit of handling (LPN).", icon: Tag, phase: "Phase 1", to: "/warehouse-app/plates" },
  { title: "Receiving", desc: "Appointment → dock → unload → inspect → GRN.", icon: Truck, phase: "Phase 2", to: "/warehouse-app/receiving" },
  { title: "Put-away", desc: "Directed put-away with scan-to-confirm.", icon: PackageOpen, phase: "Phase 3", to: "/warehouse-app/putaway" },
  { title: "Picking & Packing", desc: "Waves, pick paths, pack stations.", icon: PackageOpen, phase: "Phase 4", to: "/warehouse-app/picking" },
  { title: "Dispatch", desc: "Loading manifests, dock-out appointments.", icon: Truck, phase: "Phase 5", to: "/warehouse-app/dispatch" },
  { title: "Quality control", desc: "Inspection hold, release / quarantine / scrap.", icon: ShieldCheck, phase: "Phase 6", to: "/warehouse-app/qc" },
];

export default function WarehouseDashboard() {
  const { warehouses, isLoading } = useWarehouses();
  const { currentBusiness } = useBusinesses();

  const { data: locationCount } = useQuery({
    queryKey: ["wms-location-count", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("stock_locations")
        .select("id", { count: "exact", head: true })
        .eq("business_id", currentBusiness!.id);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const { data: authoredLayoutCount } = useQuery({
    queryKey: ["wms-authored-layout-count", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("stock_locations")
        .select("id", { count: "exact", head: true })
        .eq("business_id", currentBusiness!.id)
        .not("structure_level", "is", null);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const activeWarehouses = warehouses.filter((w) => w.is_active).length;

  return (
    <>
      <PageHeader
        title="Warehouse Operations"
        description="Physical-execution layer above Inventory. Owns location, task, dock, operator, wave."
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/warehouse-app/warehouses"><WarehouseIcon className="mr-2 h-4 w-4" />Warehouses</Link>
            </Button>
            <Button asChild>
              <Link to="/warehouse-app/layout"><Network className="mr-2 h-4 w-4" />Build layout</Link>
            </Button>
          </div>
        }
      />
      <PageBody>
        <Section>
          {isLoading ? (
            <LoadingState />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard label="Warehouses" value={warehouses.length} sub={`${activeWarehouses} active`} icon={WarehouseIcon} />
              <KpiCard label="Locations (all)" value={locationCount ?? 0} sub="Includes default + virtual" icon={Network} />
              <KpiCard label="Authored bins / zones" value={authoredLayoutCount ?? 0} sub="Rows with structure_level set" icon={Network} />
              <KpiCard label="Open operator tasks" value={0} sub="Phase 1 — pending build" icon={ClipboardList} muted />
            </div>
          )}
        </Section>

        <Section
          title="Execution roadmap"
          description="ADR 0079 — each phase ships an additive migration + a real workflow. Click a tile to preview the target surface."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ROADMAP.map((t) => (
              <Card key={t.title}>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <t.icon className="h-4 w-4 text-muted-foreground" />
                    {t.title}
                  </CardTitle>
                  <StatusBadge tone="neutral">{t.phase}</StatusBadge>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground mb-3">{t.desc}</p>
                  {t.to && (
                    <Button asChild variant="outline" size="sm">
                      <Link to={t.to}>Preview surface</Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>
      </PageBody>
    </>
  );
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  muted,
}: {
  label: string;
  value: number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  muted?: boolean;
}) {
  return (
    <Card className={muted ? "opacity-70" : undefined}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

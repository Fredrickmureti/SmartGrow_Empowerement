/**
 * Warehouse Dashboard — WMS overview.
 *
 * Real KPIs only, sourced from live tables. New KPIs are added here the
 * moment their backing domain (tasks, waves, docks, plates) ships — no
 * placeholder tiles, no dead links.
 */
import { Link } from "react-router-dom";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
} from "@/design-system";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Warehouse as WarehouseIcon, Network } from "lucide-react";
import { useWarehouses } from "@/hooks/useWarehouses";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery } from "@tanstack/react-query";

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
  const defaultOnly =
    (locationCount ?? 0) > 0 && (authoredLayoutCount ?? 0) === 0;

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
            <div className="grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-3">
              <KpiCard label="Warehouses" value={warehouses.length} sub={`${activeWarehouses} active`} icon={WarehouseIcon} />
              <KpiCard label="Locations (all)" value={locationCount ?? 0} sub="Default + authored + virtual" icon={Network} />
              <KpiCard label="Authored bins / zones" value={authoredLayoutCount ?? 0} sub="Rows with structure_level set" icon={Network} />
            </div>
          )}
        </Section>

        {defaultOnly && (
          <Section>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">No physical layout authored yet</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-3">
                <p>
                  Every warehouse currently uses a single auto-seeded default location. Author
                  zones, aisles, racks, shelves, and bins to unlock bin-level put-away, picking,
                  and cycle counts.
                </p>
                <Button asChild size="sm">
                  <Link to="/warehouse-app/layout">
                    <Network className="mr-2 h-4 w-4" />Open layout editor
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </Section>
        )}
      </PageBody>
    </>
  );
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
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

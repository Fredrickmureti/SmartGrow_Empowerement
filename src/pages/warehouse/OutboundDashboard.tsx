/**
 * Outbound Control Tower — Phase 4 §6.
 *
 * Role dashboard for the shipping supervisor: waves by state, pack-station
 * load, manifests awaiting dispatch, and short-scan exceptions. Query keys
 * reuse the prefixes the WMS realtime channel invalidates, so the board is
 * event-driven, not polled.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Waves, Boxes, Truck, AlertTriangle } from "lucide-react";
import { StateBreakdown, MetricTile } from "@/features/warehouse/dashboards/DashboardPrimitives";

export default function OutboundDashboard() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const waves = useQuery({
    queryKey: ["wms-pick-waves", "outbound-dashboard", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_waves")
        .select("id, wave_number, state")
        .eq("business_id", businessId!)
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const cartons = useQuery({
    queryKey: ["wms-pack-cartons", "outbound-dashboard", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pack_cartons")
        .select("id, sealed_at, manifest_id, wave_id")
        .eq("business_id", businessId!)
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const manifests = useQuery({
    queryKey: ["wms-loading-manifests", "outbound-dashboard", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_loading_manifests")
        .select("id, code, state, planned_departure_at")
        .eq("business_id", businessId!)
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const exceptions = useQuery({
    queryKey: ["wms_exceptions", "outbound-dashboard", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exceptions")
        .select("id, kind, state, due_by")
        .eq("business_id", businessId!)
        .in("state", ["open", "acknowledged", "investigating", "escalated"])
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const loading =
    waves.isLoading || cartons.isLoading || manifests.isLoading || exceptions.isLoading;

  const w = waves.data ?? [];
  const c = cartons.data ?? [];
  const m = manifests.data ?? [];
  const exc = exceptions.data ?? [];
  const openCartons = c.filter((x) => !x.sealed_at);
  const sealedUnloaded = c.filter((x) => x.sealed_at && !x.manifest_id);
  const awaitingDispatch = m.filter((x) => ["loading", "closed"].includes(String(x.state)));
  const shortScan = exc.filter((e) => /short|scan|dispatch/.test(String(e.kind ?? "")));

  return (
    <>
      <PageHeader
        title="Outbound control tower"
        description="Wave, pack and dispatch load for the current business."
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/warehouse-app/waves">Waves</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/warehouse-app/dispatch">Manifests</Link>
            </Button>
          </div>
        }
      />
      <PageBody>
        {loading ? (
          <LoadingState />
        ) : (
          <>
            <Section>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricTile
                  label="Waves in flight"
                  value={w.filter((x) => ["released", "picking", "picked", "packing"].includes(String(x.state))).length}
                  sub={`${w.length} total`}
                  icon={Waves}
                  to="/warehouse-app/waves"
                />
                <MetricTile
                  label="Cartons open at pack"
                  value={openCartons.length}
                  sub={`${sealedUnloaded.length} sealed, not loaded`}
                  icon={Boxes}
                />
                <MetricTile
                  label="Manifests awaiting dispatch"
                  value={awaitingDispatch.length}
                  sub={`${m.filter((x) => x.state === "dispatched").length} dispatched`}
                  icon={Truck}
                  to="/warehouse-app/dispatch"
                />
                <MetricTile
                  label="Short-scan exceptions"
                  value={shortScan.length}
                  tone={shortScan.length > 0 ? "bad" : "ok"}
                  sub={`${exc.length} open in total`}
                  icon={AlertTriangle}
                  to="/warehouse-app/exceptions"
                />
              </div>
            </Section>

            <Section title="Waves by state">
              <Card><CardContent className="p-4"><StateBreakdown rows={w} /></CardContent></Card>
            </Section>

            <Section title="Manifests by state">
              <Card><CardContent className="p-4"><StateBreakdown rows={m} /></CardContent></Card>
            </Section>

            <Section title="Outbound blockers by kind">
              <Card><CardContent className="p-4"><StateBreakdown rows={shortScan} field="kind" /></CardContent></Card>
            </Section>
          </>
        )}
      </PageBody>
    </>
  );
}

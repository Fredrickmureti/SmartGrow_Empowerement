/**
 * Inbound Control Tower — Phase 4 §6.
 *
 * Role dashboard for the receiving supervisor. Every tile is derived from
 * live WMS tables and every query key is prefixed with the key the WMS
 * realtime channel invalidates (`wms-dock-appointments`,
 * `wms-receiving-sessions`, `wms_exceptions`), so the board follows the
 * floor without polling.
 *
 * No tile links anywhere that does not exist, and no tile shows a metric
 * whose backing domain has not shipped.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Truck, PackageOpen, AlertTriangle, Shuffle } from "lucide-react";
import { StateBreakdown, MetricTile } from "@/features/warehouse/dashboards/DashboardPrimitives";

export default function InboundDashboard() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const appointments = useQuery({
    queryKey: ["wms-dock-appointments", "inbound-dashboard", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const { data, error } = await supabase
        .from("wms_dock_appointments")
        .select("id, state, appointment_type, window_start")
        .eq("business_id", businessId!)
        .eq("appointment_type", "inbound")
        .gte("window_start", since)
        .order("window_start", { ascending: true })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const sessions = useQuery({
    queryKey: ["wms-receiving-sessions", "inbound-dashboard", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_receiving_sessions")
        .select("id, state, code")
        .eq("business_id", businessId!)
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const exceptions = useQuery({
    queryKey: ["wms_exceptions", "inbound-dashboard", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exceptions")
        .select("id, kind, state, severity, due_by")
        .eq("business_id", businessId!)
        .in("state", ["open", "acknowledged", "investigating", "escalated"])
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const loading =
    appointments.isLoading || sessions.isLoading || exceptions.isLoading;

  const appts = appointments.data ?? [];
  const sess = sessions.data ?? [];
  const exc = exceptions.data ?? [];
  const inboundExceptions = exc.filter((e) =>
    /receiv|putaway|asn|dock|qc/.test(String(e.kind ?? "")),
  );
  const breached = exc.filter(
    (e) => e.due_by && new Date(e.due_by as string).getTime() < Date.now(),
  );

  return (
    <>
      <PageHeader
        title="Inbound control tower"
        description="Appointments, unload sessions and receiving blockers for the current business."
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/warehouse-app/receiving">Receiving sessions</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/warehouse-app/crossdock">
                <Shuffle className="mr-2 h-4 w-4" /> Cross-dock
              </Link>
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
              <div className="grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-4">
                <MetricTile
                  label="Appointments (last 12h + upcoming)"
                  value={appts.length}
                  sub={`${appts.filter((a) => a.state === "arrived").length} arrived`}
                  icon={Truck}
                  to="/warehouse-app/schedule"
                />
                <MetricTile
                  label="Open unload sessions"
                  value={sess.filter((s) => ["open", "unloading", "captured"].includes(String(s.state))).length}
                  sub={`${sess.filter((s) => s.state === "discrepant").length} discrepant`}
                  icon={PackageOpen}
                  to="/warehouse-app/receiving"
                />
                <MetricTile
                  label="Inbound exceptions"
                  value={inboundExceptions.length}
                  sub={`${exc.length} open in total`}
                  icon={AlertTriangle}
                  to="/warehouse-app/exceptions"
                />
                <MetricTile
                  label="SLA breached"
                  value={breached.length}
                  sub="past due_by"
                  icon={AlertTriangle}
                  tone={breached.length > 0 ? "bad" : "ok"}
                  to="/warehouse-app/exceptions"
                />
              </div>
            </Section>

            <Section title="Appointments by state">
              <Card>
                <CardContent className="p-4">
                  <StateBreakdown rows={appts} />
                </CardContent>
              </Card>
            </Section>

            <Section title="Receiving sessions by state">
              <Card>
                <CardContent className="p-4">
                  <StateBreakdown rows={sess} />
                </CardContent>
              </Card>
            </Section>

            <Section title="Inbound blockers">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Open receiving / putaway / QC exceptions</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <StateBreakdown rows={inboundExceptions} field="kind" />
                </CardContent>
              </Card>
            </Section>
          </>
        )}
      </PageBody>
    </>
  );
}

/**
 * LoadingManifests — index of `wms_loading_manifests`. Read-only; every
 * mutation lives in the planner / loading bay pages via sanctioned RPCs.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, PageBody, Section, LoadingState, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus } from "lucide-react";

interface Manifest {
  id: string;
  code: string;
  state: string;
  planned_departure_at: string | null;
  dispatched_at: string | null;
  created_at: string;
  dock: { code: string; name: string | null } | null;
}

export default function LoadingManifests() {
  const { data, isLoading } = useQuery({
    queryKey: ["wms-manifests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_loading_manifests")
        .select("id, code, state, planned_departure_at, dispatched_at, created_at, dock:dock_id(code, name)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as Manifest[];
    },
  });

  return (
    <>
      <PageHeader
        title="Dispatch"
        description="Loading manifests. Cartons must be sealed before loading; dispatch flips their LPN to shipped."
        actions={
          <Button asChild>
            <Link to="/warehouse-app/dispatch/new"><Plus className="h-4 w-4 mr-2" /> New manifest</Link>
          </Button>
        }
      />
      <PageBody>
        <Section title="Recent manifests">
          {isLoading ? <LoadingState /> : (
            <Card><CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50"><tr className="text-left">
                  <th className="p-2">Code</th><th className="p-2">Dock</th><th className="p-2">State</th><th className="p-2">Created</th><th className="p-2"></th>
                </tr></thead>
                <tbody>
                  {(data ?? []).map((m) => (
                    <tr key={m.id} className="border-t">
                      <td className="p-2 font-mono">{m.code}</td>
                      <td className="p-2">{m.dock?.code ?? "—"}</td>
                      <td className="p-2"><StatusBadge tone={m.state === "dispatched" ? "success" : m.state === "cancelled" ? "warning" : "info"}>{m.state}</StatusBadge></td>
                      <td className="p-2 text-muted-foreground">{new Date(m.created_at).toLocaleString()}</td>
                      <td className="p-2 text-right">
                        <Button size="sm" variant="outline" asChild>
                          <Link to={`/warehouse-app/dispatch/${m.id}`}>Open</Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(data ?? []).length === 0 && (
                    <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">No manifests yet.</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent></Card>
          )}
        </Section>
      </PageBody>
    </>
  );
}

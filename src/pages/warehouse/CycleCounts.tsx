/**
 * CycleCounts — index page listing recent `wms_count_sessions` with a
 * "New session" affordance. Read-only over the sessions table; every
 * write lives in Planner / Session / Review via sanctioned RPCs.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, PageBody, Section, LoadingState, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus } from "lucide-react";

interface Session {
  id: string;
  code: string;
  state: string;
  strategy: string;
  posted_at: string | null;
  created_at: string;
}

export default function CycleCounts() {
  const { data, isLoading } = useQuery({
    queryKey: ["wms-count-sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_sessions")
        .select("id, code, state, strategy, posted_at, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Session[];
    },
  });

  return (
    <>
      <PageHeader
        title="Cycle counts"
        description="Scan-first inventory counts. Variances post through the inventory adjustment RPC — Warehouse never edits stock directly."
        actions={
          <Button asChild>
            <Link to="/warehouse-app/counts/new"><Plus className="h-4 w-4 mr-2" /> New session</Link>
          </Button>
        }
      />
      <PageBody>
        <Section title="Recent sessions">
          {isLoading ? <LoadingState /> : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50"><tr className="text-left">
                    <th className="p-2">Code</th><th className="p-2">Strategy</th><th className="p-2">State</th><th className="p-2">Created</th><th className="p-2"></th>
                  </tr></thead>
                  <tbody>
                    {(data ?? []).map((s) => (
                      <tr key={s.id} className="border-t">
                        <td className="p-2 font-mono">{s.code}</td>
                        <td className="p-2">{s.strategy}</td>
                        <td className="p-2"><StatusBadge tone={s.state === "posted" ? "success" : "info"}>{s.state}</StatusBadge></td>
                        <td className="p-2 text-muted-foreground">{new Date(s.created_at).toLocaleString()}</td>
                        <td className="p-2 text-right">
                          <Button size="sm" variant="outline" asChild>
                            <Link to={`/warehouse-app/counts/${s.id}${s.state === "posted" ? "/review" : ""}`}>Open</Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {(data ?? []).length === 0 && (
                      <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">No sessions yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </Section>
      </PageBody>
    </>
  );
}

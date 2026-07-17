/**
 * CountReview — supervisor review + post surface for a
 * `wms_count_session`. Posting delegates to `post_count_session`, which
 * routes every non-zero variance through the sanctioned inventory
 * adjustment RPC. The client never touches `stock_quants` directly.
 */
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, CheckCircle2, ClipboardCheck } from "lucide-react";

interface Line {
  id: string;
  system_qty: number;
  counted_qty: number | null;
  variance_qty: number | null;
  lot_number: string | null;
  location: { name: string; code: string | null } | null;
  product: { name: string; sku: string | null } | null;
}

export default function CountReview() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: session, isLoading } = useQuery({
    queryKey: ["wms-count-session", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_sessions")
        .select("id, code, state, posted_at")
        .eq("id", sessionId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: lines } = useQuery({
    queryKey: ["wms-count-lines-review", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_lines")
        .select(
          "id, system_qty, counted_qty, variance_qty, lot_number, location:location_id(name, code), product:product_id(name, sku)",
        )
        .eq("session_id", sessionId!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as Line[];
    },
  });

  const post = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("post_count_session", { p_session_id: sessionId! });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Session posted");
      qc.invalidateQueries({ queryKey: ["wms-count-session", sessionId] });
      qc.invalidateQueries({ queryKey: ["wms-count-lines-review", sessionId] });
      nav("/warehouse-app/counts");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Post failed"),
  });

  if (isLoading) return <LoadingState />;
  if (!session) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Session not found"
        action={<Button asChild><Link to="/warehouse-app/counts">Back</Link></Button>}
      />
    );
  }

  const variances = (lines ?? []).filter((l) => l.counted_qty != null && Number(l.variance_qty ?? 0) !== 0);
  const uncounted = (lines ?? []).filter((l) => l.counted_qty == null);
  const canPost = session.state !== "posted" && session.state !== "cancelled";

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{session.code} — review</span>}
        description={<>State: <StatusBadge tone={session.state === "posted" ? "success" : "info"}>{session.state}</StatusBadge></>}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to={`/warehouse-app/counts/${sessionId}`}><ArrowLeft className="h-4 w-4 mr-2" /> Back to counting</Link>
            </Button>
            <Button disabled={!canPost || post.isPending} onClick={() => post.mutate()}>
              <CheckCircle2 className="h-4 w-4 mr-2" /> Post {variances.length} variance{variances.length === 1 ? "" : "s"}
            </Button>
          </div>
        }
      />
      <PageBody>
        {uncounted.length > 0 && (
          <Section title={`Uncounted (${uncounted.length})`} description="These lines were snapshotted but never counted. Posting treats them as no variance.">
            <Card><CardContent className="p-3 text-sm text-muted-foreground">
              {uncounted.slice(0, 20).map((l) => (
                <div key={l.id}>{l.location?.code ?? "—"} · {l.product?.name ?? l.product?.sku ?? "?"}</div>
              ))}
              {uncounted.length > 20 && <div>…and {uncounted.length - 20} more</div>}
            </CardContent></Card>
          </Section>
        )}

        <Section title={`Variances (${variances.length})`}>
          <Card>
            <CardContent className="p-0">
              {variances.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No variances — posting will just close the session.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2">Bin</th>
                      <th className="p-2">Product</th>
                      <th className="p-2">Lot</th>
                      <th className="p-2 text-right">System</th>
                      <th className="p-2 text-right">Counted</th>
                      <th className="p-2 text-right">Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {variances.map((l) => (
                      <tr key={l.id} className="border-t">
                        <td className="p-2 font-mono">{l.location?.code ?? "—"}</td>
                        <td className="p-2">{l.product?.name ?? l.product?.sku ?? "?"}</td>
                        <td className="p-2">{l.lot_number ?? "—"}</td>
                        <td className="p-2 text-right font-mono">{Number(l.system_qty).toFixed(2)}</td>
                        <td className="p-2 text-right font-mono">{Number(l.counted_qty ?? 0).toFixed(2)}</td>
                        <td className="p-2 text-right font-mono text-destructive">{Number(l.variance_qty ?? 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </Section>
      </PageBody>
    </>
  );
}

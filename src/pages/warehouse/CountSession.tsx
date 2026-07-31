/**
 * CountSession — captures counted quantities against a snapshotted set
 * of on-hand rows. Every record goes through `record_count` — the client
 * never writes `counted_qty` / `variance_qty` directly.
 *
 * Scan-first UX borrows the `BarcodeInputField` used by the Phase 4a
 * pick screen: scan a bin to focus, scan a product to select the row,
 * type the counted qty. Variance is derived server-side and displayed
 * back on the row.
 *
 * The "Review + post" affordance routes the operator to CountReview,
 * where a supervisor posts the session and every non-zero variance is
 * routed through the sanctioned inventory adjustment RPC.
 */
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ActivitySection } from "@/features/warehouse/events/ActivitySection";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { toast } from "sonner";
import { PageHeader, PageBody, Section, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";

interface CountLine {
  id: string;
  location_id: string;
  product_id: string;
  lot_number: string | null;
  system_qty: number;
  counted_qty: number | null;
  variance_qty: number | null;
  location: { name: string; code: string | null } | null;
  product: { name: string; sku: string | null } | null;
}

export default function CountSession() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const [scanBin, setScanBin] = useState("");
  const [scanProduct, setScanProduct] = useState("");
  const [countedByLine, setCountedByLine] = useState<Record<string, string>>({});
  const activeRowRef = useRef<HTMLTableRowElement | null>(null);

  const { data: session, isLoading } = useQuery({
    queryKey: ["wms-count-session", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_sessions")
        .select("id, code, state, warehouse_id, strategy")
        .eq("id", sessionId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: lines } = useQuery({
    queryKey: ["wms-count-lines", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_lines")
        .select(
          "id, location_id, product_id, lot_number, system_qty, counted_qty, variance_qty, location:location_id(name, code), product:product_id(name, sku)",
        )
        .eq("session_id", sessionId!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as CountLine[];
    },
  });

  const record = useMutation({
    mutationFn: async (v: { line_id: string; counted_qty: number }) => {
      // Phase 5.1 — replay-guarded: a double-tapped "Record" cannot post
      // the same count twice.
      await replayGuardedCall("record_count", {
        p_line_id: v.line_id,
        p_counted_qty: v.counted_qty,
        p_note: null,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-count-lines", sessionId] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Record failed"),
  });

  // Barcode-to-line resolver: match bin.code + product.sku.
  const activeLineId = useMemo(() => {
    if (!scanBin || !scanProduct) return null;
    const line = (lines ?? []).find(
      (l) =>
        (l.location?.code ?? "").toLowerCase() === scanBin.trim().toLowerCase() &&
        (l.product?.sku ?? "").toLowerCase() === scanProduct.trim().toLowerCase(),
    );
    return line?.id ?? null;
  }, [lines, scanBin, scanProduct]);

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

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{session.code}</span>}
        description={`State: ${session.state} · Strategy: ${session.strategy}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/counts"><ArrowLeft className="h-4 w-4 mr-2" /> Sessions</Link>
            </Button>
            {/* Wave 21 — cycle-count sheet header sticker (Business Event
              * → Template row `count_label`). Routes through the
              * canonical label dispatcher (ADR-0086 / ADR-0090). */}
            <PrintLabelButton
              variant="outline"
              size="default"
              label="Print count label"
              templateKey="count_label"
              workflow="generic"
              product={{
                id: session.id,
                name: `Count ${session.code}`,
                sku: session.code,
                barcode: session.code,
              }}
              sourceDocType="wms_count_session"
              sourceDocId={session.id}
              extraVars={{
                session_code: session.code,
                strategy: session.strategy ?? "",
                state: session.state ?? "",
              }}
            />
            <Button onClick={() => nav(`/warehouse-app/counts/${sessionId}/review`)}>
              <ClipboardCheck className="h-4 w-4 mr-2" /> Review + post
            </Button>
          </div>
        }
      />
      <PageBody>
        <Section title="Scan">
          <Card>
            <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Bin</Label>
                <Input placeholder="Scan or type bin code" value={scanBin} onChange={(e) => setScanBin(e.target.value)} />
              </div>
              <div>
                <Label>Product</Label>
                <Input placeholder="Scan or type product SKU" value={scanProduct} onChange={(e) => setScanProduct(e.target.value)} />
              </div>
            </CardContent>
          </Card>
        </Section>

        <Section title="Lines">
          <Card>
            <CardContent className="p-0">
              {(lines ?? []).length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">Nothing to count in this session.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2">Bin</th>
                      <th className="p-2">Product</th>
                      <th className="p-2">Lot</th>
                      <th className="p-2 text-right">System</th>
                      <th className="p-2">Counted</th>
                      <th className="p-2 text-right">Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(lines ?? []).map((l) => {
                      const isActive = l.id === activeLineId;
                      return (
                        <tr
                          key={l.id}
                          ref={isActive ? activeRowRef : null}
                          className={`border-t ${isActive ? "bg-primary/10" : ""}`}
                        >
                          <td className="p-2 font-mono">{l.location?.code ?? "—"}</td>
                          <td className="p-2">{l.product?.name ?? l.product_id}<span className="text-muted-foreground text-xs"> · {l.product?.sku ?? ""}</span></td>
                          <td className="p-2">{l.lot_number ?? "—"}</td>
                          <td className="p-2 text-right font-mono">{Number(l.system_qty).toFixed(2)}</td>
                          <td className="p-2">
                            <div className="flex gap-1">
                              <Input
                                type="number"
                                step="0.01"
                                className="w-24 h-8"
                                value={countedByLine[l.id] ?? (l.counted_qty ?? "")}
                                onChange={(e) => setCountedByLine((s) => ({ ...s, [l.id]: e.target.value }))}
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={record.isPending}
                                onClick={() => {
                                  const val = Number(countedByLine[l.id] ?? l.counted_qty ?? 0);
                                  if (Number.isNaN(val)) { toast.error("Invalid qty"); return; }
                                  record.mutate({ line_id: l.id, counted_qty: val });
                                }}
                              >
                                Save
                              </Button>
                            </div>
                          </td>
                          <td className={`p-2 text-right font-mono ${l.variance_qty && Number(l.variance_qty) !== 0 ? "text-destructive" : ""}`}>
                            {l.variance_qty == null ? "—" : Number(l.variance_qty).toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </Section>
        <ActivitySection aggregateId={sessionId} title="Session activity" description="Lifecycle events emitted for this count session." />
      </PageBody>
    </>
  );
}

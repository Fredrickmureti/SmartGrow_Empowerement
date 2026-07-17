/**
 * PackStation — closes a picked wave.
 *
 * Renders the wave's picked quantities and calls `complete_pack_task`
 * which optionally mints a shipment LPN, rolls pack quantities onto the
 * wave lines, and advances the wave to `packed`.
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, PackageCheck } from "lucide-react";

interface WaveLine {
  id: string;
  quantity_ordered: number;
  quantity_picked: number;
  quantity_packed: number;
  lot_number: string | null;
  product_id: string;
  product: { name: string; sku: string | null } | null;
}

export default function PackStation() {
  const { waveId } = useParams<{ waveId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [lpnCode, setLpnCode] = useState<string>("");

  const { data: wave, isLoading } = useQuery({
    queryKey: ["wms-pick-wave", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_waves")
        .select("id, wave_number, state, warehouse_id, released_at, completed_at")
        .eq("id", waveId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: lines } = useQuery({
    queryKey: ["wms-pick-wave-lines", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_wave_lines")
        .select("id, quantity_ordered, quantity_picked, quantity_packed, lot_number, product_id, product:product_id(name, sku)")
        .eq("wave_id", waveId!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as WaveLine[];
    },
  });

  const pack = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("complete_pack_task", {
        p_wave_id: waveId!,
        p_shipment_lpn_code: lpnCode.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Wave packed");
      qc.invalidateQueries({ queryKey: ["wms-pick-wave", waveId] });
      qc.invalidateQueries({ queryKey: ["wms-pick-wave-lines", waveId] });
      qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
      nav("/warehouse-app/waves");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Pack failed"),
  });

  if (isLoading) return <LoadingState />;
  if (!wave) {
    return (
      <EmptyState
        icon={PackageCheck}
        title="Wave not found"
        description="It may have been deleted or you do not have access."
        action={<Button asChild><Link to="/warehouse-app/waves">Back to waves</Link></Button>}
      />
    );
  }

  const canPack = wave.state === "picked" || wave.state === "packing";

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{wave.wave_number} — pack</span>}
        description={`State: ${wave.state}`}
        actions={
          <Button variant="outline" asChild>
            <Link to="/warehouse-app/waves"><ArrowLeft className="h-4 w-4 mr-2" /> Waves</Link>
          </Button>
        }
      />
      <PageBody>
        <Section title="Picked contents">
          <Card>
            <CardContent className="p-0">
              {(lines ?? []).length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No wave lines.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2">Product</th>
                      <th className="p-2">Lot</th>
                      <th className="p-2 text-right">Ordered</th>
                      <th className="p-2 text-right">Picked</th>
                      <th className="p-2 text-right">Packed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines!.map((l) => (
                      <tr key={l.id} className="border-t">
                        <td className="p-2">{l.product?.name ?? l.product_id}{l.product?.sku ? <span className="text-muted-foreground"> · {l.product.sku}</span> : null}</td>
                        <td className="p-2">{l.lot_number ?? "—"}</td>
                        <td className="p-2 text-right font-mono">{Number(l.quantity_ordered).toFixed(2)}</td>
                        <td className="p-2 text-right font-mono">{Number(l.quantity_picked).toFixed(2)}</td>
                        <td className="p-2 text-right font-mono">{Number(l.quantity_packed).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </Section>

        <Section title="Seal shipment" description="Optionally mint a shipment LPN (carton) for downstream loading/manifest.">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-end gap-2 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                  <Label htmlFor="ship-lpn">Shipment LPN code (optional)</Label>
                  <Input id="ship-lpn" placeholder="e.g. SHIP-260717-ABC" value={lpnCode} onChange={(e) => setLpnCode(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <StatusBadge tone={canPack ? "info" : "neutral"}>{canPack ? "ready" : wave.state}</StatusBadge>
                  <Button disabled={!canPack || pack.isPending} onClick={() => pack.mutate()}>
                    <PackageCheck className="h-4 w-4 mr-2" /> Complete pack
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </Section>
      </PageBody>
    </>
  );
}

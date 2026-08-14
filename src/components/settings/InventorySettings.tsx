/**
 * InventorySettings — company-scoped inventory configuration.
 *
 * Currently exposes the cost model toggle (`businesses.cost_model`):
 *   - "wac"  — weighted average cost (default; existing behavior)
 *   - "fifo" — first-in/first-out cost layer consumption
 *
 * The engine that consumes cost layers reads this column at run time; the
 * toggle here is purely the surface that lets a controller flip it without
 * a SQL console. Phase B (UoM unification) intentionally ships the toggle
 * without a FIFO engine swap — the toggle is gated visually so users know
 * FIFO is opt-in and may require historical re-layering before it produces
 * different numbers than WAC.
 */
import { useEffect, useState } from "react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

type CostModel = "wac" | "fifo";

export function InventorySettings() {
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const [costModel, setCostModel] = useState<CostModel>("wac");
  const [requirePhysical, setRequirePhysical] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);


  useEffect(() => {
    let cancelled = false;
    if (!currentBusiness?.id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    supabase
      .from("businesses")
      .select("cost_model, require_product_physical_attributes")
      .eq("id", currentBusiness.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to load inventory settings:", error);
        } else if (data) {
          if ((data as any).cost_model) setCostModel((data as any).cost_model as CostModel);
          setRequirePhysical(Boolean((data as any).require_product_physical_attributes));
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentBusiness?.id]);

  const handleSave = async () => {
    if (!currentBusiness?.id) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("businesses")
        .update({ cost_model: costModel } as any)
        .eq("id", currentBusiness.id);
      if (error) throw error;
      toast({
        title: "Cost model updated",
        description: `Inventory will value movements using ${costModel.toUpperCase()}.`,
      });
    } catch (err: unknown) {
      toast({
        title: "Couldn't save cost model",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inventory cost model</CardTitle>
        <CardDescription>
          Controls how cost of goods sold and inventory value are calculated
          when stock moves out. Affects new movements only — existing
          journal entries are not re-valued.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <RadioGroup
              value={costModel}
              onValueChange={(v) => setCostModel(v as CostModel)}
              className="space-y-3"
            >
              <div className="flex items-start gap-3 rounded-md border p-3">
                <RadioGroupItem value="wac" id="cost-wac" className="mt-0.5" />
                <div className="space-y-1">
                  <Label htmlFor="cost-wac" className="font-medium">
                    Weighted Average Cost (WAC)
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Smooths cost over all receipts. Recommended default for
                    most retail and distribution businesses.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-md border p-3">
                <RadioGroupItem value="fifo" id="cost-fifo" className="mt-0.5" />
                <div className="space-y-1">
                  <Label htmlFor="cost-fifo" className="font-medium">
                    First-In, First-Out (FIFO)
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Consumes oldest cost layers first. Required for some
                    regulated industries and audits.
                  </p>
                </div>
              </div>
            </RadioGroup>
            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

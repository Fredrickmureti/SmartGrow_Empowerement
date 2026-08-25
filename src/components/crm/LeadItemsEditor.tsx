/**
 * LeadItemsEditor — product/service line items on a CRM lead.
 *
 * Backed by `crm_lead_items`. Server-side trigger recomputes
 * `crm_leads.expected_revenue` automatically when these rows change,
 * so the lead's headline value always reflects the line-item total
 * once any item is added.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2, Plus } from "lucide-react";
import { toast } from "sonner";

interface LeadItem {
  id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  line_total?: number;
}

interface Props {
  leadId: string;
  organizationId: string;
  businessId: string | null;
  onChanged?: () => void;
}

export function LeadItemsEditor({ leadId, organizationId, businessId, onChanged }: Props) {
  const [items, setItems] = useState<LeadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("crm_lead_items")
      .select("*")
      .eq("lead_id", leadId)
      .order("sort_order", { ascending: true });
    if (error) {
      console.error(error);
      toast.error("Failed to load lead items");
    } else {
      setItems((data ?? []) as LeadItem[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (leadId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  const addRow = () => {
    setItems((prev) => [
      ...prev,
      { product_id: null, description: "", quantity: 1, unit_price: 0, discount_percent: 0 },
    ]);
  };

  const updateLocal = (index: number, patch: Partial<LeadItem>) => {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  };

  const persist = async (index: number) => {
    const it = items[index];
    if (!it.description.trim()) {
      toast.error("Description is required");
      return;
    }
    if (!it.id && !businessId) {
      // business_id is mandatory on crm_lead_items and must match the lead's business.
      toast.error("Select a company before adding lines to this lead");
      return;
    }
    setSaving(it.id ?? `new-${index}`);
    try {
      if (it.id) {
        const { error } = await supabase
          .from("crm_lead_items")
          .update({
            description: it.description,
            quantity: it.quantity,
            unit_price: it.unit_price,
            discount_percent: it.discount_percent,
            product_id: it.product_id,
          })
          .eq("id", it.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("crm_lead_items")
          .insert({
            lead_id: leadId,
            organization_id: organizationId,
            business_id: businessId,
            description: it.description,
            quantity: it.quantity,
            unit_price: it.unit_price,
            discount_percent: it.discount_percent,
            product_id: it.product_id,
            sort_order: index,
          })
          .select()
          .single();
        if (error) throw error;
        updateLocal(index, { id: (data as any).id });
      }
      await load();
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to save line");
    } finally {
      setSaving(null);
    }
  };

  const remove = async (index: number) => {
    const it = items[index];
    if (it.id) {
      const { error } = await supabase.from("crm_lead_items").delete().eq("id", it.id);
      if (error) {
        toast.error(error.message);
        return;
      }
    }
    setItems((prev) => prev.filter((_, i) => i !== index));
    onChanged?.();
  };

  const total = items.reduce(
    (s, it) => s + it.quantity * it.unit_price * (1 - (it.discount_percent || 0) / 100),
    0,
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Products &amp; services</Label>
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-4 w-4 mr-1" /> Add line
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No products attached. Add lines to populate downstream estimates,
          sales orders, and projects automatically.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={it.id ?? `n-${i}`} className="grid grid-cols-12 gap-2 items-end border rounded-md p-2">
              <div className="col-span-5">
                <Label className="text-xs">Description</Label>
                <Input
                  value={it.description}
                  onChange={(e) => updateLocal(i, { description: e.target.value })}
                  onBlur={() => persist(i)}
                  placeholder="e.g. Implementation services"
                />
              </div>
              <div className="col-span-2">
                <Label className="text-xs">Qty</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={it.quantity}
                  onChange={(e) => updateLocal(i, { quantity: parseFloat(e.target.value) || 0 })}
                  onBlur={() => persist(i)}
                />
              </div>
              <div className="col-span-2">
                <Label className="text-xs">Unit price</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={it.unit_price}
                  onChange={(e) => updateLocal(i, { unit_price: parseFloat(e.target.value) || 0 })}
                  onBlur={() => persist(i)}
                />
              </div>
              <div className="col-span-2">
                <Label className="text-xs">Disc %</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={it.discount_percent}
                  onChange={(e) =>
                    updateLocal(i, { discount_percent: parseFloat(e.target.value) || 0 })
                  }
                  onBlur={() => persist(i)}
                />
              </div>
              <div className="col-span-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(i)}
                  disabled={saving === (it.id ?? `new-${i}`)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end text-sm">
        <span className="text-muted-foreground mr-2">Total</span>
        <span className="font-medium">{total.toFixed(2)}</span>
      </div>
    </div>
  );
}

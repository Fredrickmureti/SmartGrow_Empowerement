/**
 * Scrap / Waste record — routed create surface.
 *
 * Replaces the legacy `Record Scrap` dialog that used to live inside
 * `ScrapRecording.tsx`. Same `record_scrap_atomic` RPC contract; only the
 * shell changed. Cancel routes back to the scrap log; submit navigates back
 * on success so the new movement appears in the recent list.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useProducts } from "@/hooks/useProducts";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { normalizeError } from "@/services/resilience";

const SCRAP_REASONS = [
  "Damaged",
  "Expired",
  "Defective",
  "Obsolete",
  "Quality Failure",
  "Other",
] as const;

export default function ScrapNew() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const { products } = useProducts();
  const queryClient = useQueryClient();

  const inventoryProducts = products.filter((p) => p.type === "product");

  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    let q = supabase
      .from("warehouses")
      .select("id, name")
      .eq("organization_id", currentOrg.id)
      .eq("is_active", true)
      .eq("business_id", currentBusiness.id);
    if (currentBranch?.id) q = q.eq("branch_id", currentBranch.id);
    q.then(({ data }: any) => setWarehouses(data || []));
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  const [form, setForm] = useState({
    product_id: "",
    warehouse_id: "",
    quantity: 1,
    reason: "",
    notes: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const invalid =
    !form.product_id || !form.reason || form.quantity <= 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentOrg?.id || !user?.id || invalid) return;
    setIsSubmitting(true);
    try {
      const product = inventoryProducts.find((p) => p.id === form.product_id);
      const costPrice = (product as any)?.cost_price || 0;
      const { data, error } = await supabase.rpc("record_scrap_atomic", {
        p_organization_id: currentOrg.id,
        p_business_id: currentBusiness?.id || null,
        p_product_id: form.product_id,
        p_warehouse_id: form.warehouse_id || null,
        p_quantity: form.quantity,
        p_unit_cost: costPrice,
        p_reason: form.reason,
        p_notes: form.notes || null,
        p_user_id: user.id,
      });
      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Failed to record scrap");
      }
      toast.success(
        `Scrap recorded successfully${result.gl_posted ? " (GL posted)" : ""}`,
      );
      queryClient.invalidateQueries({ queryKey: ["scrap-movements"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      navigate("/inventory-app/scrap");
    } catch (err: any) {
      toast.error(normalizeError(err).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Scrap Record"
      cancelHref="/inventory-app/scrap"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={invalid}
      submitLabel="Record Scrap"
    >
      <Section title="Item" description="What was scrapped and from where.">
        <FieldGrid columns={2}>
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label>Product *</Label>
              <Select
                value={form.product_id}
                onValueChange={(v) => setForm((f) => ({ ...f, product_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select product" />
                </SelectTrigger>
                <SelectContent>
                  {inventoryProducts.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FieldCell>
          <div className="space-y-2">
            <Label>Warehouse</Label>
            <Select
              value={form.warehouse_id}
              onValueChange={(v) => setForm((f) => ({ ...f, warehouse_id: v }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Quantity *</Label>
            <Input
              type="number"
              min={1}
              value={form.quantity}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  quantity: parseInt(e.target.value) || 0,
                }))
              }
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Reason" description="Why this stock is being written off.">
        <FieldGrid columns={1}>
          <div className="space-y-2">
            <Label>Reason *</Label>
            <Select
              value={form.reason}
              onValueChange={(v) => setForm((f) => ({ ...f, reason: v }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select reason" />
              </SelectTrigger>
              <SelectContent>
                {SCRAP_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Additional Notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.target.value }))
              }
              placeholder="Optional details..."
            />
          </div>
        </FieldGrid>
      </Section>
    </RecordFormShell>
  );
}
/**
 * AssetFormSheet — create/edit a Fixed Asset. Mounted on DetailSheet.
 * URL-driven behind `?sheet=asset[&id=<uuid>]`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { format } from "date-fns";
import {
  DetailSheet,
  FieldGrid,
  FieldCell,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import {
  useFixedAssets,
  type FixedAsset,
} from "@/hooks/useFixedAssets";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset?: FixedAsset | null;
}

const emptyForm = () => ({
  name: "",
  description: "",
  category_id: "",
  purchase_date: format(new Date(), "yyyy-MM-dd"),
  purchase_price: 0,
  residual_value: 0,
  useful_life_years: 5,
  depreciation_method: "straight_line",
  serial_number: "",
  location: "",
  vendor_id: "",
});

export function AssetFormSheet({ open, onOpenChange, asset }: Props) {
  const { categories, createAsset, updateAsset } = useFixedAssets();
  const { toast } = useToast();
  const mode: "create" | "edit" = asset ? "edit" : "create";

  const [form, setForm] = useState(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (asset) {
      setForm({
        name: asset.name,
        description: asset.description || "",
        category_id: asset.category_id || "",
        purchase_date: asset.purchase_date,
        purchase_price: asset.purchase_price,
        residual_value: asset.residual_value || 0,
        useful_life_years: asset.useful_life_years || 5,
        depreciation_method: asset.depreciation_method || "straight_line",
        serial_number: asset.serial_number || "",
        location: asset.location || "",
        vendor_id: asset.vendor_id || "",
      });
    } else {
      setForm(emptyForm());
    }
  }, [open, asset]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (mode === "edit" && asset) {
        await updateAsset(asset.id, {
          name: form.name,
          description: form.description || null,
          category_id: form.category_id || null,
          purchase_date: form.purchase_date,
          purchase_price: form.purchase_price,
          residual_value: form.residual_value,
          useful_life_years: form.useful_life_years,
          depreciation_method: form.depreciation_method,
          serial_number: form.serial_number || null,
          location: form.location || null,
          vendor_id: form.vendor_id || null,
        });
        toast({ title: "Asset updated successfully" });
      } else {
        await createAsset({
          name: form.name,
          description: form.description || null,
          category_id: form.category_id || null,
          purchase_date: form.purchase_date,
          purchase_price: form.purchase_price,
          residual_value: form.residual_value,
          useful_life_years: form.useful_life_years,
          depreciation_method: form.depreciation_method,
          serial_number: form.serial_number || null,
          location: form.location || null,
          vendor_id: form.vendor_id || null,
          invoice_reference: null,
          branch_id: null,
          assigned_to: null,
          depreciation_start_date: null,
          accumulated_depreciation: 0,
          book_value: form.purchase_price,
          status: "active",
          disposal_date: null,
          disposal_price: null,
          disposal_reason: null,
          barcode: null,
          insurance_value: null,
          insurance_policy: null,
          insurance_expiry: null,
          warranty_expiry: null,
          notes: null,
        });
        toast({ title: "Asset created successfully" });
      }
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={mode === "edit" ? "Edit asset" : "New asset"}
      description={
        mode === "edit"
          ? "Update the asset details."
          : "Enter the asset information below."
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" form="asset-form" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === "edit" ? "Save changes" : "Create asset"}
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <form id="asset-form" onSubmit={handleSubmit} className="space-y-4">
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="a-name">Name *</Label>
              <Input
                id="a-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
          </FieldCell>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="a-desc">Description</Label>
              <Textarea
                id="a-desc"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                rows={2}
              />
            </div>
          </FieldCell>
          <div className="space-y-2">
            <Label htmlFor="a-category">Category</Label>
            <Select
              value={form.category_id}
              onValueChange={(v) => setForm({ ...form, category_id: v })}
            >
              <SelectTrigger id="a-category">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-serial">Serial number</Label>
            <Input
              id="a-serial"
              value={form.serial_number}
              onChange={(e) =>
                setForm({ ...form, serial_number: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-pdate">Purchase date *</Label>
            <Input
              id="a-pdate"
              type="date"
              value={form.purchase_date}
              onChange={(e) =>
                setForm({ ...form, purchase_date: e.target.value })
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-price">Purchase price *</Label>
            <Input
              id="a-price"
              type="number"
              min="0"
              step="0.01"
              value={form.purchase_price}
              onChange={(e) =>
                setForm({
                  ...form,
                  purchase_price: parseFloat(e.target.value) || 0,
                })
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-residual">Residual value</Label>
            <Input
              id="a-residual"
              type="number"
              min="0"
              step="0.01"
              value={form.residual_value}
              onChange={(e) =>
                setForm({
                  ...form,
                  residual_value: parseFloat(e.target.value) || 0,
                })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-life">Useful life (years)</Label>
            <Input
              id="a-life"
              type="number"
              min="1"
              value={form.useful_life_years}
              onChange={(e) =>
                setForm({
                  ...form,
                  useful_life_years: parseInt(e.target.value) || 5,
                })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-method">Depreciation method</Label>
            <Select
              value={form.depreciation_method}
              onValueChange={(v) => setForm({ ...form, depreciation_method: v })}
            >
              <SelectTrigger id="a-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="straight_line">Straight Line</SelectItem>
                <SelectItem value="reducing_balance">Reducing Balance</SelectItem>
                <SelectItem value="units_of_production">
                  Units of Production
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-location">Location</Label>
            <Input
              id="a-location"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
          </div>
        </FieldGrid>
      </form>
    </DetailSheet>
  );
}

export default AssetFormSheet;

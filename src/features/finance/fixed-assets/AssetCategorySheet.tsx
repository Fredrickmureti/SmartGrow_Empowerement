/**
 * AssetCategorySheet — create a Fixed Asset Category with GL account
 * mappings. Mounted on DetailSheet. URL-driven behind `?sheet=category`.
 */
import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { useFixedAssets } from "@/hooks/useFixedAssets";
import { useAccounts } from "@/hooks/useAccounts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const emptyForm = () => ({
  name: "",
  description: "",
  depreciation_method: "straight_line",
  useful_life_years: 5,
  depreciation_rate: 20,
  asset_account_id: "",
  depreciation_account_id: "",
  accumulated_depreciation_account_id: "",
  gain_loss_account_id: "",
});

const GL_MAPPINGS: Array<{
  key: keyof ReturnType<typeof emptyForm>;
  label: string;
  type: "asset" | "expense";
}> = [
  { key: "asset_account_id", label: "Asset Account", type: "asset" },
  { key: "depreciation_account_id", label: "Depreciation Expense", type: "expense" },
  {
    key: "accumulated_depreciation_account_id",
    label: "Accumulated Depreciation",
    type: "asset",
  },
  { key: "gain_loss_account_id", label: "Gain/Loss on Disposal", type: "expense" },
];

export function AssetCategorySheet({ open, onOpenChange }: Props) {
  const { createCategory } = useFixedAssets();
  const { accounts } = useAccounts();
  const { toast } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await createCategory({
        name: form.name,
        description: form.description || null,
        depreciation_method: form.depreciation_method,
        useful_life_years: form.useful_life_years,
        depreciation_rate: form.depreciation_rate,
        asset_account_id: form.asset_account_id || null,
        depreciation_account_id: form.depreciation_account_id || null,
        accumulated_depreciation_account_id:
          form.accumulated_depreciation_account_id || null,
        gain_loss_account_id: form.gain_loss_account_id || null,
        is_active: true,
      });
      toast({ title: "Category created successfully" });
      setForm(emptyForm());
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
      size="md"
      title="Add asset category"
      description="Create a new category with GL account mappings."
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
              <Button
                type="submit"
                form="asset-category-form"
                disabled={isSubmitting}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create category
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <form
        id="asset-category-form"
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="cat-name">Name *</Label>
          <Input
            id="cat-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cat-desc">Description</Label>
          <Input
            id="cat-desc"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="cat-method">Depreciation method</Label>
            <Select
              value={form.depreciation_method}
              onValueChange={(v) => setForm({ ...form, depreciation_method: v })}
            >
              <SelectTrigger id="cat-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="straight_line">Straight Line</SelectItem>
                <SelectItem value="reducing_balance">Reducing Balance</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cat-life">Useful life (years)</Label>
            <Input
              id="cat-life"
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
        </FieldGrid>

        <Separator className="my-2" />
        <p className="text-sm font-medium">GL account mappings</p>
        <FieldGrid columns={2}>
          {GL_MAPPINGS.map(({ key, label, type }) => (
            <FieldCell key={key} span="full">
              <div className="space-y-2">
                <Label>{label}</Label>
                <Select
                  value={(form[key] as string) || ""}
                  onValueChange={(v) => setForm({ ...form, [key]: v })}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={`Select ${label.toLowerCase()}`}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts
                      .filter((a) => a.account_type === type && a.is_active)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </FieldCell>
          ))}
        </FieldGrid>
      </form>
    </DetailSheet>
  );
}

export default AssetCategorySheet;

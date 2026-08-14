/** Price, cost and the tax rate the product carries by default. */
import { Section, FieldGrid } from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProductFormPatch, ProductFormValues } from "../formState";

export interface PricingTaxRateOption {
  id: string;
  name: string;
  rate: number;
  is_active?: boolean | null;
  etims_tax_code?: string | null;
}

export interface PricingSectionProps {
  values: ProductFormValues;
  onChange: ProductFormPatch;
  taxRates: PricingTaxRateOption[];
}

export function PricingSection({ values, onChange, taxRates }: PricingSectionProps) {
  return (
    <Section title="Pricing" description="What you sell it for.">
      <FieldGrid columns={3}>
        <div className="space-y-2">
          <Label htmlFor="unit_price">Price *</Label>
          <Input
            id="unit_price"
            type="number"
            step="0.01"
            min="0"
            value={values.unit_price}
            onChange={(e) => onChange({ unit_price: parseFloat(e.target.value) || 0 })}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cost_price">Cost</Label>
          <Input
            id="cost_price"
            type="number"
            step="0.01"
            min="0"
            value={values.cost_price}
            onChange={(e) => onChange({ cost_price: parseFloat(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tax_rate">Tax rate</Label>
          <Select
            value={values.tax_rate_id || "custom"}
            onValueChange={(v) => {
              if (v === "custom") {
                onChange({ tax_rate_id: null });
              } else if (v === "none") {
                onChange({ tax_rate_id: null, tax_rate: 0 });
              } else {
                const selectedRate = taxRates.find((t) => t.id === v);
                onChange({ tax_rate_id: v, tax_rate: selectedRate?.rate || 0 });
              }
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select tax rate" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No tax (0%)</SelectItem>
              {taxRates
                .filter((t) => t.is_active)
                .map((rate) => (
                  <SelectItem key={rate.id} value={rate.id}>
                    <div className="flex items-center gap-2">
                      <span>
                        {rate.name} ({rate.rate}%)
                      </span>
                      {rate.etims_tax_code && (
                        <span className="text-xs text-muted-foreground font-mono">
                          [{rate.etims_tax_code}]
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              <SelectItem value="custom">Custom rate...</SelectItem>
            </SelectContent>
          </Select>
          {!values.tax_rate_id && (
            <div className="flex gap-2 items-center mt-2">
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="Enter rate %"
                value={values.tax_rate}
                onChange={(e) => onChange({ tax_rate: parseFloat(e.target.value) || 0 })}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          )}
        </div>
      </FieldGrid>
    </Section>
  );
}

export default PricingSection;

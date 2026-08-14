/**
 * Fiscal metadata for the active jurisdiction. These codes are NOT product
 * master data — they persist in `product_tax_localization` through
 * `save_product_atomic`'s `localization` payload.
 */
import { FileCheck2 } from "lucide-react";
import { Section, FieldGrid } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EtimsUnitCodeSelect,
  EtimsPackagingCodeSelect,
  EtimsClassificationCodeSelect,
  EtimsCountryOriginSelect,
} from "@/components/etims/EtimsCodeSelectors";
import type {
  ProductFormPatch,
  ProductFormValues,
  ProductLocalizationPatch,
  ProductLocalizationValues,
} from "../formState";
import type { PricingTaxRateOption } from "./PricingSection";

export interface TaxComplianceSectionProps {
  values: ProductFormValues;
  onChange: ProductFormPatch;
  localization: ProductLocalizationValues;
  onLocalizationChange: ProductLocalizationPatch;
  taxRates: PricingTaxRateOption[];
  regimeName?: string | null;
}

export function TaxComplianceSection({
  values,
  onChange,
  localization,
  onLocalizationChange,
  taxRates,
  regimeName,
}: TaxComplianceSectionProps) {
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-muted-foreground" /> Tax compliance —{" "}
          {regimeName}
        </span>
      }
      description="Codes transmitted with invoices and receipts for fiscal reporting."
    >
      <FieldGrid columns={2}>
        <div className="space-y-2">
          <Label>Tax rate (with compliance code)</Label>
          <Select
            value={values.tax_rate_id || "none"}
            onValueChange={(v) => {
              const selectedRate = taxRates.find((t) => t.id === v);
              onChange({
                tax_rate_id: v === "none" ? null : v,
                tax_rate: selectedRate?.rate || 0,
              });
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select tax rate" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No tax</SelectItem>
              {taxRates
                .filter((t) => t.is_active)
                .map((rate) => (
                  <SelectItem key={rate.id} value={rate.id}>
                    <div className="flex items-center gap-2">
                      <span>
                        {rate.name} ({rate.rate}%)
                      </span>
                      {rate.etims_tax_code && (
                        <Badge variant="outline" className="font-mono text-xs">
                          {rate.etims_tax_code}
                        </Badge>
                      )}
                    </div>
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <EtimsClassificationCodeSelect
          value={localization.classification_code}
          onChange={(v) => onLocalizationChange({ classification_code: v })}
        />
        <EtimsUnitCodeSelect
          value={localization.unit_code}
          onChange={(v) => onLocalizationChange({ unit_code: v })}
        />
        <EtimsPackagingCodeSelect
          value={localization.packaging_unit}
          onChange={(v) => onLocalizationChange({ packaging_unit: v })}
        />
        <EtimsCountryOriginSelect
          value={localization.origin_country}
          onChange={(v) => onLocalizationChange({ origin_country: v })}
        />
      </FieldGrid>
    </Section>
  );
}

export default TaxComplianceSection;

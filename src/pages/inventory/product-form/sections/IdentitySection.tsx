/** Identity: what operators search for. Presentation only. */
import { Section, FieldGrid, FieldCell } from "@/design-system";
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
import { ProductCategorySelector } from "@/components/products/ProductCategorySelector";
import type { ProductFormPatch, ProductFormValues } from "../formState";

export interface IdentitySectionProps {
  values: ProductFormValues;
  onChange: ProductFormPatch;
  disabled?: boolean;
}

export function IdentitySection({ values, onChange, disabled }: IdentitySectionProps) {
  return (
    <Section title="Identity" description="What operators search for.">
      <FieldGrid columns={2}>
        <FieldCell span={2}>
          <div className="space-y-2">
            <Label htmlFor="p_name">Name *</Label>
            <Input
              id="p_name"
              value={values.name}
              onChange={(e) => onChange({ name: e.target.value })}
              required
            />
          </div>
        </FieldCell>
        <div className="space-y-2">
          <Label htmlFor="p_type">Type *</Label>
          <Select
            value={values.type}
            onValueChange={(value: "product" | "service") => onChange({ type: value })}
          >
            <SelectTrigger id="p_type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="product">Product</SelectItem>
              <SelectItem value="service">Service</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ProductCategorySelector
          value={values.category_id}
          onChange={(id) => onChange({ category_id: id })}
          disabled={disabled}
        />
        <div className="space-y-2">
          <Label htmlFor="p_sku">SKU</Label>
          <Input
            id="p_sku"
            value={values.sku}
            onChange={(e) => onChange({ sku: e.target.value })}
          />
        </div>
        <FieldCell span={2}>
          <div className="space-y-2">
            <Label htmlFor="p_desc">Description</Label>
            <Textarea
              id="p_desc"
              value={values.description}
              onChange={(e) => onChange({ description: e.target.value })}
              rows={3}
            />
          </div>
        </FieldCell>
      </FieldGrid>
    </Section>
  );
}

export default IdentitySection;

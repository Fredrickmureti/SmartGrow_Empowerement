/**
 * AssetFormBody — shared form body used by AssetCreatePage +
 * AssetEditPage. Presentational only; the parent page owns state and
 * submit.
 */
import { format } from "date-fns";

import { Section } from "@/design-system";
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
import type { AssetCategory } from "@/hooks/useFixedAssets";

export interface AssetFormValues {
  name: string;
  description: string;
  category_id: string;
  purchase_date: string;
  purchase_price: number;
  /**
   * Transaction currency of the acquisition. The form never sends a rate:
   * the acquisition rate and the base cost are stamped server-side by the
   * one FX engine on `purchase_date`.
   */
  currency: string;
  residual_value: number;
  useful_life_years: number;
  depreciation_method: string;
  serial_number: string;
  location: string;
  vendor_id: string;
}

export const emptyAssetForm = (): AssetFormValues => ({
  name: "",
  description: "",
  category_id: "",
  purchase_date: format(new Date(), "yyyy-MM-dd"),
  purchase_price: 0,
  currency: "",
  residual_value: 0,
  useful_life_years: 5,
  depreciation_method: "straight_line",
  serial_number: "",
  location: "",
  vendor_id: "",
});

interface Props {
  values: AssetFormValues;
  onChange: (next: AssetFormValues) => void;
  categories: AssetCategory[];
  /** Currencies this business is enabled to transact in (server-resolved). */
  currencyOptions: string[];
  baseCurrency: string;
  /**
   * Acquisition currency/date/cost are frozen once the asset has been
   * depreciated or its acquisition has posted. The database refuses the
   * change; the form explains it instead of letting the write fail.
   */
  acquisitionLocked?: boolean;
  acquisitionLockReason?: string;
}

export function AssetFormBody({
  values,
  onChange,
  categories,
  currencyOptions,
  baseCurrency,
  acquisitionLocked = false,
  acquisitionLockReason,
}: Props) {
  const set = <K extends keyof AssetFormValues>(k: K, v: AssetFormValues[K]) =>
    onChange({ ...values, [k]: v });

  return (
    <>
      <Section title="Identity" description="Name, category, and serial.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="a-name">Name *</Label>
            <Input
              id="a-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="a-desc">Description</Label>
            <Textarea
              id="a-desc"
              rows={2}
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-category">Category</Label>
            <Select
              value={values.category_id}
              onValueChange={(v) => set("category_id", v)}
            >
              <SelectTrigger id="a-category">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-serial">Serial number</Label>
            <Input
              id="a-serial"
              value={values.serial_number}
              onChange={(e) => set("serial_number", e.target.value)}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="a-location">Location</Label>
            <Input
              id="a-location"
              value={values.location}
              onChange={(e) => set("location", e.target.value)}
            />
          </div>
        </div>
      </Section>

      <Section
        title="Cost & depreciation"
        description={
          acquisitionLocked
            ? acquisitionLockReason ??
              "Acquisition currency, date and cost are frozen because this asset has been depreciated or posted."
            : "Cost is recorded in the acquisition currency. The exchange rate and the base-currency cost are stamped by the system on the purchase date."
        }
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="a-pdate">Purchase date *</Label>
            <Input
              id="a-pdate"
              type="date"
              value={values.purchase_date}
              onChange={(e) => set("purchase_date", e.target.value)}
              disabled={acquisitionLocked}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-currency">Currency *</Label>
            <Select
              value={values.currency || baseCurrency}
              onValueChange={(v) => set("currency", v)}
              disabled={acquisitionLocked}
            >
              <SelectTrigger id="a-currency">
                <SelectValue placeholder="Select currency" />
              </SelectTrigger>
              <SelectContent>
                {currencyOptions.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                    {code === baseCurrency ? " (base)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-price">
              Purchase price * {values.currency ? `(${values.currency})` : ""}
            </Label>
            <Input
              id="a-price"
              type="number"
              min="0"
              step="0.01"
              value={values.purchase_price}
              onChange={(e) =>
                set("purchase_price", parseFloat(e.target.value) || 0)
              }
              disabled={acquisitionLocked}
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
              value={values.residual_value}
              onChange={(e) =>
                set("residual_value", parseFloat(e.target.value) || 0)
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-life">Useful life (years)</Label>
            <Input
              id="a-life"
              type="number"
              min="1"
              value={values.useful_life_years}
              onChange={(e) =>
                set("useful_life_years", parseInt(e.target.value) || 5)
              }
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="a-method">Depreciation method</Label>
            <Select
              value={values.depreciation_method}
              onValueChange={(v) => set("depreciation_method", v)}
            >
              <SelectTrigger id="a-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="straight_line">Straight Line</SelectItem>
                <SelectItem value="reducing_balance">
                  Reducing Balance
                </SelectItem>
                <SelectItem value="units_of_production">
                  Units of Production
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </Section>
    </>
  );
}

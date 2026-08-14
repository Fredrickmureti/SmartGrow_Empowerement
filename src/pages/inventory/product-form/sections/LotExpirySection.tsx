/** Lot / expiry tracking policy. FEFO allocation itself is server-side. */
import { Section } from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ProductFormPatch, ProductFormValues } from "../formState";

export interface LotExpirySectionProps {
  values: ProductFormValues;
  onChange: ProductFormPatch;
  /** Show the "pre-enabled for your industry" hint (create mode only). */
  showIndustryHint?: boolean;
}

export function LotExpirySection({
  values,
  onChange,
  showIndustryHint,
}: LotExpirySectionProps) {
  return (
    <Section
      title="Lot & expiry tracking"
      description="FEFO allocation and expiry dashboard."
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label className="text-sm font-medium">Track lot / batch numbers</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Each receipt records a lot number. Sales, deliveries and POS auto-pick
              lots first-expiry-first-out (FEFO), or you can override at checkout.
            </p>
            {showIndustryHint && (
              <p className="text-[11px] text-primary mt-1">
                Pre-enabled for your industry — toggle off if not needed.
              </p>
            )}
          </div>
          <Switch
            checked={values.is_lot_tracked}
            onCheckedChange={(v) =>
              onChange({
                is_lot_tracked: v,
                is_expiry_tracked: v ? values.is_expiry_tracked : false,
              })
            }
          />
        </div>
        {values.is_lot_tracked && (
          <>
            <div className="flex items-start justify-between gap-3 border-t pt-3">
              <div>
                <Label className="text-sm font-medium">Track expiry dates</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Surfaces lots in the "Lots expiring soon" dashboard widget once they
                  enter the alert window.
                </p>
              </div>
              <Switch
                checked={values.is_expiry_tracked}
                onCheckedChange={(v) => onChange({ is_expiry_tracked: v })}
              />
            </div>
            {values.is_expiry_tracked && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 border-t pt-3">
                <div className="space-y-1 md:col-span-1">
                  <Label htmlFor="expiry_alert_days">Alert window (days)</Label>
                  <Input
                    id="expiry_alert_days"
                    type="number"
                    min={1}
                    max={365}
                    value={values.expiry_alert_days}
                    onChange={(e) =>
                      onChange({
                        expiry_alert_days: Math.max(
                          1,
                          parseInt(e.target.value, 10) || 30,
                        ),
                      })
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground md:col-span-2 self-end">
                  Lots within this many days of expiry appear on the inventory
                  dashboard. Defaults to 30.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

export default LotExpirySection;

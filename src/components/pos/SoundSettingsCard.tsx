import { Volume2, VolumeX, Play } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { usePOSSound } from "@/hooks/pos/usePOSSound";
import type { POSSoundEvent } from "@/lib/pos/sounds";

const PREVIEWS: { event: POSSoundEvent; label: string; help: string }[] = [
  { event: "product_click", label: "Product tap", help: "Plays when a product tile is added to the cart" },
  { event: "barcode_scan", label: "Barcode scan", help: "Plays when a scanned barcode matches a product" },
  { event: "payment_success", label: "Payment success", help: "Plays after a sale is completed" },
  { event: "error", label: "Error / invalid", help: "Plays when an action fails" },
  { event: "cart_remove", label: "Remove item", help: "Plays when a single line is removed from the cart" },
  { event: "cart_clear", label: "Clear cart", help: "Plays when the entire cart is wiped" },
  { event: "discount_applied", label: "Discount applied", help: "Plays when a manual or promo discount lands on the cart" },
  { event: "cash_drawer_open", label: "Cash drawer", help: "Plays when the cash drawer is kicked or a no-sale is performed" },
  { event: "manager_override", label: "Manager override", help: "Plays when a supervisor PIN approves a restricted action" },
  { event: "shift_open", label: "Shift opened", help: "Plays when a cashier successfully opens a shift" },
  { event: "shift_close", label: "Shift closed", help: "Plays when a shift is closed and reconciled" },
  { event: "hold", label: "Hold transaction", help: "Plays when the current cart is parked for later" },
  { event: "recall", label: "Recall transaction", help: "Plays when a held cart is brought back" },
  { event: "low_stock_warning", label: "Low / out of stock", help: "Soft warning chirp when a product is low or out of stock" },
  { event: "receipt_print", label: "Receipt print", help: "Plays when a receipt is sent to the printer" },
];

export function SoundSettingsCard() {
  const { enabled, volume, setEnabled, setVolume, play } = usePOSSound();
  const Icon = enabled ? Volume2 : VolumeX;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5" />
          Sound Effects
        </CardTitle>
        <CardDescription>
          Subtle audio feedback for product taps, scans, payments, and errors.
          This preference is saved on this device only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="pos-sound-enabled" className="text-base">
              Enable sound effects
            </Label>
            <p className="text-sm text-muted-foreground">
              Turn off for quiet environments.
            </p>
          </div>
          <Switch
            id="pos-sound-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="pos-sound-volume">Volume</Label>
            <span className="text-sm text-muted-foreground tabular-nums">
              {Math.round(volume * 100)}%
            </span>
          </div>
          <Slider
            id="pos-sound-volume"
            value={[Math.round(volume * 100)]}
            min={0}
            max={100}
            step={5}
            onValueChange={(v) => setVolume((v[0] ?? 0) / 100)}
            disabled={!enabled}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-sm">Preview</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {PREVIEWS.map((p) => (
              <Button
                key={p.event}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => play(p.event)}
                disabled={!enabled}
                className="justify-start"
                title={p.help}
              >
                <Play className="h-3.5 w-3.5 mr-2" />
                {p.label}
              </Button>
            ))}
          </div>
          {!enabled && (
            <p className="text-xs text-muted-foreground">
              Enable sound effects to preview.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

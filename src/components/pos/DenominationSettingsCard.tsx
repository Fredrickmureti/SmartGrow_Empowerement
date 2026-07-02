import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { Coins, Plus, X, Save, Loader2, RotateCcw } from "lucide-react";

const CURRENCY_PRESETS: Record<string, number[]> = {
  KES: [1000, 500, 200, 100, 50, 40, 20, 10, 5, 1],
  USD: [100, 50, 20, 10, 5, 2, 1, 0.25, 0.10, 0.05, 0.01],
  EUR: [500, 200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10, 0.05, 0.02, 0.01],
  GBP: [50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10, 0.05, 0.02, 0.01],
  NGN: [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1],
  ZAR: [200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10],
  UGX: [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100],
  TZS: [10000, 5000, 2000, 1000, 500, 200, 100, 50],
};

export function DenominationSettingsCard() {
  const { settings, updateSetting } = usePOSSettings();
  const { currentBusiness } = useBusinesses();
  const orgCurrency = currentBusiness?.base_currency || "USD"; // architecture-allow: display-only fallback

  // Load current denomination profile from settings
  const currentProfile = (() => {
    const setting = settings?.find(s => s.setting_key === "denomination_profile");
    if (setting?.setting_value && typeof setting.setting_value === "object" && !Array.isArray(setting.setting_value)) {
      const profile = setting.setting_value as Record<string, unknown>;
      if (Array.isArray(profile.denominations)) {
        return profile.denominations as number[];
      }
    }
    return null;
  })();

  const [denominations, setDenominations] = useState<number[]>(
    currentProfile || CURRENCY_PRESETS[orgCurrency] || CURRENCY_PRESETS.USD
  );
  const [newDenomination, setNewDenomination] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Sync when settings load
  useEffect(() => {
    if (currentProfile && !isDirty) {
      setDenominations(currentProfile);
    }
  }, [currentProfile, isDirty]);

  const handleAddDenomination = () => {
    const value = parseFloat(newDenomination);
    if (isNaN(value) || value <= 0) {
      toast.error("Enter a valid positive number");
      return;
    }
    if (denominations.includes(value)) {
      toast.error("This denomination already exists");
      return;
    }
    setDenominations(prev => [...prev, value].sort((a, b) => b - a));
    setNewDenomination("");
    setIsDirty(true);
  };

  const handleRemoveDenomination = (value: number) => {
    setDenominations(prev => prev.filter(d => d !== value));
    setIsDirty(true);
  };

  const handleLoadPreset = (currency: string) => {
    const preset = CURRENCY_PRESETS[currency];
    if (preset) {
      setDenominations([...preset]);
      setIsDirty(true);
    }
  };

  const handleSave = async () => {
    if (!updateSetting) return;
    setIsSaving(true);
    try {
      await updateSetting({
        setting_key: "denomination_profile",
        setting_value: { denominations, currency: orgCurrency },
      });
      setIsDirty(false);
      toast.success("Denomination profile saved");
    } catch {
      toast.error("Failed to save denomination profile");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="h-4 w-4" />
          Cash Denomination Profile
        </CardTitle>
        <CardDescription className="text-xs">
          Configure which cash denominations appear in the denomination counter during shift close.
          Your org currency is <Badge variant="outline" className="text-xs ml-1">{orgCurrency}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Preset buttons */}
        <div className="space-y-2">
          <Label className="text-sm">Load Currency Preset</Label>
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(CURRENCY_PRESETS).map(currency => (
              <Button
                key={currency}
                variant={currency === orgCurrency ? "default" : "outline"}
                size="sm"
                className="text-xs h-7 px-2"
                onClick={() => handleLoadPreset(currency)}
              >
                {currency}
              </Button>
            ))}
          </div>
        </div>

        {/* Current denominations */}
        <div className="space-y-2">
          <Label className="text-sm">Active Denominations ({denominations.length})</Label>
          <div className="flex flex-wrap gap-1.5">
            {denominations.map(d => (
              <Badge key={d} variant="secondary" className="flex items-center gap-1 text-xs px-2 py-1">
                {d >= 1 ? d.toLocaleString() : d.toFixed(2)}
                <button
                  type="button"
                  onClick={() => handleRemoveDenomination(d)}
                  className="ml-0.5 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        </div>

        {/* Add new denomination */}
        <div className="flex items-end gap-2">
          <div className="space-y-1 flex-1">
            <Label className="text-xs">Add Denomination</Label>
            <Input
              type="number"
              placeholder="e.g. 500"
              value={newDenomination}
              onChange={e => setNewDenomination(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAddDenomination()}
              className="h-8 text-sm"
              min="0"
              step="any"
            />
          </div>
          <Button size="sm" variant="outline" className="h-8" onClick={handleAddDenomination}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add
          </Button>
        </div>

        {/* Save / Reset */}
        <div className="flex items-center gap-2 pt-2 border-t">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1.5" />
            )}
            Save Profile
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDenominations(currentProfile || CURRENCY_PRESETS[orgCurrency] || CURRENCY_PRESETS.USD);
              setIsDirty(false);
            }}
            disabled={!isDirty}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

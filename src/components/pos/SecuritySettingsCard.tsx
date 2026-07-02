import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { usePOSSecuritySettings } from "@/hooks/pos/usePOSSecuritySettings";
import { Shield, Loader2, Save, Key } from "lucide-react";

export function SecuritySettingsCard() {
  const { settings, isLoading, updateSettings, setManagerPin, hasManagerPin } = usePOSSecuritySettings();

  const [localSettings, setLocalSettings] = useState(settings);
  const [isDirty, setIsDirty] = useState(false);
  const [newManagerPin, setNewManagerPin] = useState("");
  const [confirmManagerPin, setConfirmManagerPin] = useState("");

  // Sync local state when settings load, without overwriting in-progress edits.
  useEffect(() => {
    if (!isDirty) {
      setLocalSettings(settings);
    }
  }, [settings, isDirty]);

  const handleChange = (key: string, value: boolean | number) => {
    setLocalSettings(prev => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const handleSave = async () => {
    await updateSettings.mutateAsync(localSettings);
    setIsDirty(false);
  };

  const handleSetManagerPin = async () => {
    if (newManagerPin.length < 4 || newManagerPin !== confirmManagerPin) return;
    await setManagerPin.mutateAsync(newManagerPin);
    setNewManagerPin("");
    setConfirmManagerPin("");
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            POS Security Settings
          </CardTitle>
          <CardDescription>
            Configure security policies for your POS terminals
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* PIN Settings */}
          <div className="space-y-4">
            <h3 className="font-medium">Authentication</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Require Cashier PIN</p>
                <p className="text-sm text-muted-foreground">
                  Cashiers must enter PIN to access terminal
                </p>
              </div>
              <Switch
                checked={localSettings.require_cashier_pin}
                onCheckedChange={(checked) => handleChange("require_cashier_pin", checked)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>PIN Length</Label>
                <Input
                  type="number"
                  min="4"
                  max="8"
                  value={localSettings.pin_length}
                  onChange={(e) => handleChange("pin_length", parseInt(e.target.value) || 4)}
                />
              </div>
              <div className="space-y-2">
                <Label>Session Timeout (minutes)</Label>
                <Input
                  type="number"
                  min="5"
                  max="480"
                  value={localSettings.session_timeout_minutes}
                  onChange={(e) => handleChange("session_timeout_minutes", parseInt(e.target.value) || 30)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Lock After Inactivity (minutes)</Label>
              <Input
                type="number"
                min="1"
                max="60"
                value={localSettings.lock_after_inactivity_minutes}
                onChange={(e) => handleChange("lock_after_inactivity_minutes", parseInt(e.target.value) || 5)}
              />
              <p className="text-xs text-muted-foreground">
                Terminal will lock after this period of inactivity
              </p>
            </div>
          </div>

          <Separator />

          {/* Manager Override Settings — non-action-specific only.
              Action-specific PIN/threshold rules (void, return, discount, cash-out,
              safe-drop, bank-deposit, shift-variance) are now configured under
              POS Settings → Security → Override Matrix. The matrix is the single
              server-side source of truth via assert_manager_override. */}
          <div className="space-y-4">
            <h3 className="font-medium">Manager Approval Requirements</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">Price Override</p>
                </div>
                <Switch
                  checked={localSettings.require_manager_pin_for_price_override}
                  onCheckedChange={(checked) => handleChange("require_manager_pin_for_price_override", checked)}
                />
              </div>
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">Open Cash Drawer</p>
                </div>
                <Switch
                  checked={localSettings.require_manager_pin_for_drawer_open}
                  onCheckedChange={(checked) => handleChange("require_manager_pin_for_drawer_open", checked)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground border-l-2 border-primary/50 pl-3">
              Voids, refunds, discounts, cash-outs, safe drops, bank deposits and
              shift-variance approvals are now driven by the Override Matrix (per
              action, with thresholds and role restrictions). Edit them in
              <strong> Security → Override Matrix</strong> below.
            </p>
          </div>

          <Separator />

          {/* Offline Settings */}
          <div className="space-y-4">
            <h3 className="font-medium">Offline Mode</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Allow Offline Transactions</p>
                <p className="text-sm text-muted-foreground">
                  Allow sales when internet is unavailable
                </p>
              </div>
              <Switch
                checked={localSettings.allow_offline_transactions}
                onCheckedChange={(checked) => handleChange("allow_offline_transactions", checked)}
              />
            </div>
            {localSettings.allow_offline_transactions && (
              <div className="space-y-2">
                <Label>Max Offline Transaction Amount</Label>
                <Input
                  type="number"
                  min="0"
                  value={localSettings.max_offline_transaction_amount}
                  onChange={(e) => handleChange("max_offline_transaction_amount", parseFloat(e.target.value) || 0)}
                />
              </div>
            )}
          </div>

          <Button 
            onClick={handleSave} 
            disabled={!isDirty || updateSettings.isPending}
            className="w-full sm:w-auto"
          >
            {updateSettings.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Security Settings
          </Button>
        </CardContent>
      </Card>

      {/* Manager PIN Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Your Manager PIN
          </CardTitle>
          <CardDescription>
            Set your PIN for approving cashier overrides
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>New PIN</Label>
              <Input
                type="password"
                maxLength={6}
                placeholder="Enter 4-6 digit PIN"
                value={newManagerPin}
                onChange={(e) => setNewManagerPin(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="space-y-2">
              <Label>Confirm PIN</Label>
              <Input
                type="password"
                maxLength={6}
                placeholder="Confirm PIN"
                value={confirmManagerPin}
                onChange={(e) => setConfirmManagerPin(e.target.value.replace(/\D/g, ""))}
              />
            </div>
          </div>
          {newManagerPin && confirmManagerPin && newManagerPin !== confirmManagerPin && (
            <p className="text-sm text-destructive">PINs do not match</p>
          )}
          <Button
            onClick={handleSetManagerPin}
            disabled={newManagerPin.length < 4 || newManagerPin !== confirmManagerPin || setManagerPin.isPending}
          >
            {setManagerPin.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {hasManagerPin ? "Update Manager PIN" : "Set Manager PIN"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

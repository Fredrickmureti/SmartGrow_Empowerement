import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useNotificationAlertSettings } from "@/hooks/useNotificationAlertSettings";
import { 
  Package, 
  FileText, 
  CreditCard, 
  Receipt, 
  Clock,
  AlertTriangle,
  AlertCircle,
  XCircle,
  Loader2,
  Save
} from "lucide-react";
import { useState, useEffect } from "react";

/**
 * Parse a number input value WITHOUT silently snapping `0` or empty input
 * to a magic constant. Returns:
 *   - the parsed number if it's a valid finite number (including 0),
 *   - `fallback` (the previous committed value) for empty / NaN entries.
 */
function parseNumberInput(raw: string, fallback: number): number {
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function NotificationThresholdSettings() {
  const { settings, isLoading, updateSettings, isUpdating } = useNotificationAlertSettings();
  
  // Local state for form
  const [localSettings, setLocalSettings] = useState(settings);
  
  useEffect(() => {
    if (settings) {
      setLocalSettings(settings);
    }
  }, [settings]);

  const handleSave = () => {
    // Send ONLY the editable threshold/digest fields. Never spread the full
    // settings object — it may contain id/created_at/updated_at from the DB
    // which must not be re-sent.
    updateSettings({
      low_stock_warning_threshold: localSettings.low_stock_warning_threshold,
      low_stock_critical_threshold: localSettings.low_stock_critical_threshold,
      out_of_stock_alert: localSettings.out_of_stock_alert,
      invoice_reminder_days_before: localSettings.invoice_reminder_days_before,
      overdue_reminder_frequency_days: localSettings.overdue_reminder_frequency_days,
      overdue_escalation_enabled: localSettings.overdue_escalation_enabled,
      payment_received_notify: localSettings.payment_received_notify,
      large_payment_threshold: localSettings.large_payment_threshold,
      expense_approval_required_above: localSettings.expense_approval_required_above,
      daily_digest_enabled: localSettings.daily_digest_enabled,
      weekly_digest_enabled: localSettings.weekly_digest_enabled,
      digest_send_hour: localSettings.digest_send_hour,
      digest_timezone: localSettings.digest_timezone,
    });
  };

  const hasChanges = JSON.stringify(localSettings) !== JSON.stringify(settings);

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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5" />
          Alert Thresholds
        </CardTitle>
        <CardDescription>
          Configure when you receive alerts for different events. These settings apply to your organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        {/* Inventory Alerts */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium">Inventory Alerts</h3>
          </div>
          
          <div className="space-y-6 pl-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="flex items-center gap-2">
                    <AlertCircle className="h-3.5 w-3.5 text-yellow-500" />
                    Warning Threshold
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Alert when stock falls below this level
                  </p>
                </div>
                <div className="flex items-center gap-2 w-32">
                  <Input
                    type="number"
                    min={0}
                    value={localSettings.low_stock_warning_threshold}
                    onChange={(e) => setLocalSettings(prev => {
                      const nextWarning = parseNumberInput(e.target.value, prev.low_stock_warning_threshold);
                      // Re-clamp critical so it never exceeds warning.
                      const nextCritical = Math.min(prev.low_stock_critical_threshold, nextWarning);
                      return {
                        ...prev,
                        low_stock_warning_threshold: nextWarning,
                        low_stock_critical_threshold: nextCritical,
                      };
                    })}
                    className="text-right"
                  />
                  <span className="text-sm text-muted-foreground">units</span>
                </div>
              </div>
              <Slider
                value={[localSettings.low_stock_warning_threshold]}
                onValueChange={([value]) => setLocalSettings(prev => ({
                  ...prev,
                  low_stock_warning_threshold: value,
                  low_stock_critical_threshold: Math.min(prev.low_stock_critical_threshold, value),
                }))}
                min={1}
                max={100}
                step={1}
                className="w-full"
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="flex items-center gap-2">
                    <XCircle className="h-3.5 w-3.5 text-red-500" />
                    Critical Threshold
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Urgent alert when stock is critically low (must be ≤ warning)
                  </p>
                </div>
                <div className="flex items-center gap-2 w-32">
                  <Input
                    type="number"
                    min={0}
                    max={localSettings.low_stock_warning_threshold}
                    value={localSettings.low_stock_critical_threshold}
                    onChange={(e) => setLocalSettings(prev => {
                      const raw = parseNumberInput(e.target.value, prev.low_stock_critical_threshold);
                      // Hard-clamp at the form layer to match the schema rule (critical <= warning).
                      const clamped = Math.min(Math.max(raw, 0), prev.low_stock_warning_threshold);
                      return { ...prev, low_stock_critical_threshold: clamped };
                    })}
                    className="text-right"
                  />
                  <span className="text-sm text-muted-foreground">units</span>
                </div>
              </div>
              <Slider
                value={[localSettings.low_stock_critical_threshold]}
                onValueChange={([value]) => setLocalSettings(prev => ({
                  ...prev,
                  low_stock_critical_threshold: Math.min(value, prev.low_stock_warning_threshold),
                }))}
                min={0}
                max={Math.max(0, localSettings.low_stock_warning_threshold)}
                step={1}
                className="w-full"
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Out of Stock Alerts</Label>
                <p className="text-xs text-muted-foreground">
                  Receive immediate alert when stock reaches zero
                </p>
              </div>
              <Switch
                checked={localSettings.out_of_stock_alert}
                onCheckedChange={(checked) => setLocalSettings(prev => ({
                  ...prev,
                  out_of_stock_alert: checked
                }))}
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Invoice Alerts */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium">Invoice Alerts</h3>
          </div>
          
          <div className="space-y-4 pl-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Reminder Before Due Date</Label>
                <p className="text-xs text-muted-foreground">
                  Days before due date to send payment reminder
                </p>
              </div>
              <div className="flex items-center gap-2 w-32">
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={localSettings.invoice_reminder_days_before}
                  onChange={(e) => setLocalSettings(prev => ({
                    ...prev,
                    invoice_reminder_days_before: parseNumberInput(e.target.value, prev.invoice_reminder_days_before)
                  }))}
                  className="text-right"
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Overdue Reminder Frequency</Label>
                <p className="text-xs text-muted-foreground">
                  How often to remind about overdue invoices
                </p>
              </div>
              <div className="flex items-center gap-2 w-32">
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={localSettings.overdue_reminder_frequency_days}
                  onChange={(e) => setLocalSettings(prev => ({
                    ...prev,
                    overdue_reminder_frequency_days: parseNumberInput(e.target.value, prev.overdue_reminder_frequency_days)
                  }))}
                  className="text-right"
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Escalation Alerts</Label>
                <p className="text-xs text-muted-foreground">
                  Escalate to managers for long-overdue invoices
                </p>
              </div>
              <Switch
                checked={localSettings.overdue_escalation_enabled}
                onCheckedChange={(checked) => setLocalSettings(prev => ({
                  ...prev,
                  overdue_escalation_enabled: checked
                }))}
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Payment Alerts */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium">Payment Alerts</h3>
          </div>
          
          <div className="space-y-4 pl-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Payment Received Notifications</Label>
                <p className="text-xs text-muted-foreground">
                  Notify when payments are received
                </p>
              </div>
              <Switch
                checked={localSettings.payment_received_notify}
                onCheckedChange={(checked) => setLocalSettings(prev => ({
                  ...prev,
                  payment_received_notify: checked
                }))}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Large Payment Threshold</Label>
                <p className="text-xs text-muted-foreground">
                  Highlight payments above this amount
                </p>
              </div>
              <div className="flex items-center gap-2 w-36">
                <Input
                  type="number"
                  min={0}
                  value={localSettings.large_payment_threshold}
                  onChange={(e) => setLocalSettings(prev => ({
                    ...prev,
                    large_payment_threshold: parseNumberInput(e.target.value, prev.large_payment_threshold)
                  }))}
                  className="text-right"
                />
              </div>
            </div>
          </div>
        </div>

        <Separator />

        {/* Expense Alerts */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium">Expense Alerts</h3>
          </div>
          
          <div className="space-y-4 pl-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Approval Required Above</Label>
                <p className="text-xs text-muted-foreground">
                  Flag expenses above this amount for approval
                </p>
              </div>
              <div className="flex items-center gap-2 w-36">
                <Input
                  type="number"
                  min={0}
                  value={localSettings.expense_approval_required_above}
                  onChange={(e) => setLocalSettings(prev => ({
                    ...prev,
                    expense_approval_required_above: parseNumberInput(e.target.value, prev.expense_approval_required_above)
                  }))}
                  className="text-right"
                />
              </div>
            </div>
          </div>
        </div>

        <Separator />

        {/* Digest Settings */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium">Digest Settings</h3>
          </div>
          
          <div className="space-y-4 pl-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Daily Digest</Label>
                <p className="text-xs text-muted-foreground">
                  Receive a daily summary of notifications
                </p>
              </div>
              <Switch
                checked={localSettings.daily_digest_enabled}
                onCheckedChange={(checked) => setLocalSettings(prev => ({
                  ...prev,
                  daily_digest_enabled: checked
                }))}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Weekly Digest</Label>
                <p className="text-xs text-muted-foreground">
                  Receive a weekly summary every Monday
                </p>
              </div>
              <Switch
                checked={localSettings.weekly_digest_enabled}
                onCheckedChange={(checked) => setLocalSettings(prev => ({
                  ...prev,
                  weekly_digest_enabled: checked
                }))}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Send Time</Label>
                <p className="text-xs text-muted-foreground">
                  Hour of day to send digest (24-hour format)
                </p>
              </div>
              <div className="flex items-center gap-2 w-24">
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={localSettings.digest_send_hour}
                  onChange={(e) => setLocalSettings(prev => ({
                    ...prev,
                    digest_send_hour: parseNumberInput(e.target.value, prev.digest_send_hour)
                  }))}
                  className="text-right"
                />
                <span className="text-sm text-muted-foreground">:00</span>
              </div>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex justify-end pt-4">
          <Button 
            onClick={handleSave} 
            disabled={!hasChanges || isUpdating}
          >
            {isUpdating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save Threshold Settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

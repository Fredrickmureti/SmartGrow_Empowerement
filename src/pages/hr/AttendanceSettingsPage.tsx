/**
 * AttendanceSettingsPage — runtime-used settings.
 *
 * Late grace, OT threshold/multiplier, auto-checkout, correction approval,
 * kiosk PIN requirement, leave-block-on-clock-in. All values are consumed
 * by SECURITY DEFINER RPCs and the calculate_worked_hours function.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, CalendarCheck } from "lucide-react";
import { useAttendanceSettings } from "@/hooks/hr/useAttendanceSettings";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export default function AttendanceSettingsPage() {
  const { settings, isLoading, update, isUpdating } = useAttendanceSettings();
  const [draft, setDraft] = useState<Record<string, any>>({});
  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = `${new Date().getFullYear()}-12-31`;
  const [backfillFrom, setBackfillFrom] = useState<string>(today);
  const [backfillTo, setBackfillTo] = useState<string>(yearEnd);
  const [backfilling, setBackfilling] = useState(false);

  const runHolidayBackfill = async () => {
    if (!backfillFrom || !backfillTo) {
      toast.error("Pick a from and to date");
      return;
    }
    setBackfilling(true);
    try {
      const { data, error } = await supabase.rpc("attendance_stamp_holidays" as any, {
        _from: backfillFrom,
        _to: backfillTo,
      });
      if (error) throw error;
      const count = typeof data === "number" ? data : (data as any)?.stamped ?? 0;
      toast.success(`Stamped ${count} holiday attendance row(s)`);
    } catch (e: any) {
      toast.error(e?.message ?? "Holiday backfill failed");
    } finally {
      setBackfilling(false);
    }
  };

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  if (isLoading || !settings) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const set = (k: string, v: any) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance Settings</h1>
          <p className="text-sm text-muted-foreground">
            All values below are enforced server-side by attendance RPCs.
          </p>
        </div>
        <div className="action-buttons">
          <Button
            disabled={!dirty || isUpdating}
            onClick={() => update(draft)}
          >
            {isUpdating ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : null}
            Save changes
          </Button>
        </div>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="trust">Trust &amp; Geofence</TabsTrigger>
          <TabsTrigger value="kiosk">Kiosk &amp; Holidays</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Working hours</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <FieldNumber
                label="Late grace (minutes)"
                value={draft.late_grace_minutes}
                onChange={(v) => set("late_grace_minutes", v)}
                help="Minutes after scheduled start before status flips to 'late'."
              />
              <FieldNumber
                label="Overtime threshold (hours)"
                value={draft.overtime_threshold_hours}
                step={0.25}
                onChange={(v) => set("overtime_threshold_hours", v)}
                help="Hours per session before overtime starts accruing."
              />
              <FieldNumber
                label="Overtime multiplier"
                value={draft.overtime_multiplier}
                step={0.25}
                onChange={(v) => set("overtime_multiplier", v)}
                help="Pay multiplier applied to overtime hours in payroll."
              />
              <FieldNumber
                label="Auto-checkout after (hours)"
                value={draft.auto_checkout_after_hours}
                onChange={(v) => set("auto_checkout_after_hours", v)}
                help="Open sessions older than this are auto-closed by the cron job."
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="policies" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Corrections &amp; approval</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldSwitch
                label="Allow employees to request corrections"
                value={draft.allow_self_correction}
                onChange={(v) => set("allow_self_correction", v)}
              />
              <FieldSwitch
                label="Require manager approval for corrections"
                value={draft.require_manager_approval_for_correction}
                onChange={(v) => set("require_manager_approval_for_correction", v)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Shift window enforcement</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldSwitch
                label="Enforce shift window (consult shift assignments)"
                value={draft.enforce_shift_window}
                onChange={(v) => set("enforce_shift_window", v)}
              />
              <div className="grid gap-4 md:grid-cols-2">
                <FieldNumber
                  label="Early clock-in grace (minutes)"
                  value={draft.early_clock_in_minutes}
                  onChange={(v) => set("early_clock_in_minutes", v)}
                  help="How early before shift start clock-in is allowed."
                />
                <FieldNumber
                  label="Late clock-in grace (minutes)"
                  value={draft.late_clock_in_minutes}
                  onChange={(v) => set("late_clock_in_minutes", v)}
                  help="How late after shift start clock-in is allowed."
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Overtime &amp; payroll</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldSwitch
                label="Require pre-approved overtime requests for payroll"
                value={draft.require_ot_preapproval}
                onChange={(v) => set("require_ot_preapproval", v)}
              />
              <FieldSwitch
                label="Require attendance approval before payroll"
                value={draft.require_approval_for_payroll}
                onChange={(v) => set("require_approval_for_payroll", v)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trust" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Anti-fraud (server-enforced)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldSwitch
                label="Require geofenced clock-in (work location lat/lng/radius)"
                value={draft.geofence_required}
                onChange={(v) => set("geofence_required", v)}
              />
              <FieldSwitch
                label="Require selfie capture on every clock action"
                value={draft.selfie_required}
                onChange={(v) => set("selfie_required", v)}
              />
              <FieldSwitch
                label="Require trusted-device binding (HR must approve new devices)"
                value={draft.device_binding_required}
                onChange={(v) => set("device_binding_required", v)}
              />
              <FieldSwitch
                label="Allow offline clock-in (queues and syncs later)"
                value={draft.allow_offline_clock}
                onChange={(v) => set("allow_offline_clock", v)}
              />
              <FieldNumber
                label="Max clock drift (minutes)"
                value={draft.max_clock_drift_minutes}
                onChange={(v) => set("max_clock_drift_minutes", v)}
                help="Minutes before scheduled shift start that clock-in is allowed."
              />
              <FieldNumber
                label="Min interval between clocks (seconds)"
                value={draft.min_clock_interval_seconds}
                onChange={(v) => set("min_clock_interval_seconds", v)}
                help="Blocks DUPLICATE_RECENT_ATTEMPT within this window."
              />
              <FieldNumber
                label="Max plausible speed (km/h)"
                value={draft.max_speed_kmh}
                onChange={(v) => set("max_speed_kmh", v)}
                help="Used for IMPOSSIBLE_TRAVEL detection between consecutive clocks."
              />
              <div className="space-y-1.5">
                <Label>Impossible travel action</Label>
                <select
                  className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                  value={draft.impossible_travel_action ?? "flag"}
                  onChange={(e) => set("impossible_travel_action", e.target.value)}
                >
                  <option value="flag">Flag (allow + audit)</option>
                  <option value="deny">Deny clock-in</option>
                </select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="kiosk" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Kiosk &amp; leave</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldSwitch
                label="Require kiosk PIN at shared devices"
                value={draft.kiosk_pin_required}
                onChange={(v) => set("kiosk_pin_required", v)}
              />
              <FieldSwitch
                label="Block clock-in on approved leave days"
                value={draft.block_clock_in_on_approved_leave}
                onChange={(v) => set("block_clock_in_on_approved_leave", v)}
              />
              <FieldSwitch
                label="Enable missing-checkout cron"
                value={draft.missing_checkout_cron_enabled}
                onChange={(v) => set("missing_checkout_cron_enabled", v)}
              />
              <FieldSwitch
                label="Auto-stamp attendance on public holidays"
                value={draft.holiday_auto_stamp}
                onChange={(v) => set("holiday_auto_stamp", v)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarCheck className="h-4 w-4" /> Holiday backfill
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Stamp <code className="text-xs">status='holiday'</code> attendance rows for every active employee
                across a date range. Existing rows on the same day are left untouched.
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>From</Label>
                  <Input type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>To</Label>
                  <Input type="date" value={backfillTo} onChange={(e) => setBackfillTo(e.target.value)} />
                </div>
                <div className="flex items-end">
                  <Button onClick={runHolidayBackfill} disabled={backfilling} className="w-full">
                    {backfilling && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                    Run backfill
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}


function FieldNumber({
  label,
  value,
  onChange,
  help,
  step = 1,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
  help?: string;
  step?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        step={step}
        value={value ?? 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function FieldSwitch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={!!value} onCheckedChange={onChange} />
    </div>
  );
}

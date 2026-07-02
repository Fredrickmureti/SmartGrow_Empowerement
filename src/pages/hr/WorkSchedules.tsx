import { normalizeError } from "@/services/resilience";
/**
 * Work Schedules Management Page (Phase 5)
 * Create and manage work schedules that can be assigned to employees for attendance tracking.
 * Now DB-persisted via work_schedules + work_schedule_days tables.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { AttendanceFormShell } from "@/components/attendance/_shared/AttendanceFormShell";
import { WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Clock, Edit, Trash2, Loader2 } from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { format } from "date-fns";
import { toast } from "sonner";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface DaySchedule {
  day: string;
  isWorkDay: boolean;
  startTime: string;
  endTime: string;
  breakMinutes: number;
}

const DEFAULT_DAYS: DaySchedule[] = DAYS.map(day => ({
  day,
  isWorkDay: !["Saturday", "Sunday"].includes(day),
  startTime: "08:00",
  endTime: "17:00",
  breakMinutes: 60,
}));

export default function WorkSchedules() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDays, setFormDays] = useState<DaySchedule[]>(DEFAULT_DAYS);

  // Fetch schedules with their days
  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ["work-schedules", orgId, businessId],
    queryFn: async () => {
      if (!orgId || !businessId) return [];
      const { data: scheds, error } = await supabase
        .from("work_schedules")
        .select("*")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("is_default", { ascending: false });
      if (error) throw error;

      const { data: days, error: dErr } = await supabase
        .from("work_schedule_days")
        .select("*")
        .in("schedule_id", (scheds || []).map(s => s.id));
      if (dErr) throw dErr;

      return (scheds || []).map(s => ({
        ...s,
        days: DAYS.map(day => {
          const found = (days || []).find(d => d.schedule_id === s.id && d.day_of_week === day);
          return {
            day,
            isWorkDay: found ? found.is_work_day : false,
            startTime: found?.start_time?.slice(0, 5) || "08:00",
            endTime: found?.end_time?.slice(0, 5) || "17:00",
            breakMinutes: found?.break_minutes ?? 60,
          } as DaySchedule;
        }),
      }));
    },
    enabled: !!orgId && !!businessId,
  });

  const calcHours = (days: DaySchedule[]) => {
    return days.reduce((total, d) => {
      if (!d.isWorkDay) return total;
      const [sh, sm] = d.startTime.split(":").map(Number);
      const [eh, em] = d.endTime.split(":").map(Number);
      const worked = (eh * 60 + em) - (sh * 60 + sm) - d.breakMinutes;
      return total + Math.max(0, worked / 60);
    }, 0);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!orgId || !businessId) throw new Error("No company selected");
      const hoursPerWeek = calcHours(formDays);

      if (editingId) {
        const { error } = await supabase
          .from("work_schedules")
          .update({ name: formName, standard_hours_per_week: hoursPerWeek, updated_at: new Date().toISOString() })
          .eq("id", editingId);
        if (error) throw error;

        await supabase.from("work_schedule_days").delete().eq("schedule_id", editingId);
        const { error: dErr } = await supabase.from("work_schedule_days").insert(
          formDays.map(d => ({
            schedule_id: editingId,
            day_of_week: d.day,
            is_work_day: d.isWorkDay,
            start_time: d.isWorkDay ? d.startTime + ":00" : null,
            end_time: d.isWorkDay ? d.endTime + ":00" : null,
            break_minutes: d.breakMinutes,
          }))
        );
        if (dErr) throw dErr;
      } else {
        const { data: newSched, error } = await supabase
          .from("work_schedules")
          .insert({
            organization_id: orgId,
            business_id: businessId,
            name: formName,
            standard_hours_per_week: hoursPerWeek,
            is_default: false,
          })
          .select("id")
          .single();
        if (error) throw error;

        const { error: dErr } = await supabase.from("work_schedule_days").insert(
          formDays.map(d => ({
            schedule_id: newSched.id,
            day_of_week: d.day,
            is_work_day: d.isWorkDay,
            start_time: d.isWorkDay ? d.startTime + ":00" : null,
            end_time: d.isWorkDay ? d.endTime + ":00" : null,
            break_minutes: d.breakMinutes,
          }))
        );
        if (dErr) throw dErr;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["work-schedules"] });
      setShowDialog(false);
      toast.success(editingId ? "Schedule updated" : "Schedule created");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("work_schedules").update({ is_active: false }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["work-schedules"] });
      toast.success("Schedule deleted");
    },
    onError: (e) => toast.error(normalizeError(e).message),
  });

  const openCreate = () => {
    setEditingId(null);
    setFormName("");
    setFormDays(DEFAULT_DAYS.map(d => ({ ...d })));
    setShowDialog(true);
  };

  const openEdit = (s: typeof schedules[0]) => {
    setEditingId(s.id);
    setFormName(s.name);
    setFormDays(s.days.map(d => ({ ...d })));
    setShowDialog(true);
  };

  const updateDay = (index: number, updates: Partial<DaySchedule>) => {
    setFormDays(prev => prev.map((d, i) => i === index ? { ...d, ...updates } : d));
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header — responsive */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Work Schedules</h1>
          <p className="text-sm sm:text-base text-muted-foreground">Define work schedules for attendance and payroll calculations</p>
        </div>
        <div className="action-buttons w-full sm:w-auto">
          <ReportExportButtons
            getExportConfig={() => ({
              title: "Work Schedules",
              companyName: currentOrg?.name || undefined,
              dateRange: `As of ${format(new Date(), "MMM d, yyyy")}`,
              columns: [
                { key: "name", header: "Schedule Name", width: 24 },
                { key: "hours_per_week", header: "Hours/Week", format: "number", width: 12, align: "right" },
                { key: "work_days", header: "Work Days", width: 30 },
                { key: "is_default", header: "Default", width: 10 },
              ],
              rows: schedules.map((s) => ({
                name: s.name,
                hours_per_week: Number(s.standard_hours_per_week || 0),
                work_days: s.days.filter(d => d.isWorkDay).map(d => d.day.slice(0, 3)).join(", "),
                is_default: s.is_default ? "Yes" : "No",
              })),
              organizationId: orgId,
            } as ExportConfig)}
            formats={["excel", "csv", "pdf"]}
            compact
          />
          <Button onClick={openCreate} className="flex-1 sm:flex-none"><Plus className="h-4 w-4 mr-2" /> New Schedule</Button>
        </div>
      </div>

      {schedules.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Clock className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No work schedules yet. Create one to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {schedules.map(schedule => (
            <Card key={schedule.id}>
              <CardHeader>
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Clock className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{schedule.name}</CardTitle>
                      <CardDescription>{Number(schedule.standard_hours_per_week || 0).toFixed(1)} hours/week</CardDescription>
                    </div>
                    {schedule.is_default && <Badge variant="secondary">Default</Badge>}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEdit(schedule)}>
                      <Edit className="h-4 w-4 mr-1" /> Edit
                    </Button>
                    {!schedule.is_default && (
                      <Button variant="outline" size="sm" onClick={() => deleteMutation.mutate(schedule.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {/* Desktop: 7-col grid */}
                <div className="hidden sm:grid grid-cols-7 gap-2">
                  {schedule.days.map(day => (
                    <div key={day.day} className={`text-center p-2 rounded-lg text-sm ${day.isWorkDay ? "bg-primary/5 border border-primary/20" : "bg-muted"}`}>
                      <p className="font-medium">{day.day.slice(0, 3)}</p>
                      {day.isWorkDay ? (
                        <p className="text-xs text-muted-foreground mt-1">{day.startTime}–{day.endTime}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-1">Off</p>
                      )}
                    </div>
                  ))}
                </div>
                {/* Mobile: compact list */}
                <div className="sm:hidden space-y-1">
                  {schedule.days.map(day => (
                    <div key={day.day} className={`flex items-center justify-between px-3 py-1.5 rounded text-sm ${day.isWorkDay ? "bg-primary/5" : "bg-muted"}`}>
                      <span className="font-medium">{day.day.slice(0, 3)}</span>
                      {day.isWorkDay ? (
                        <span className="text-xs text-muted-foreground">{day.startTime}–{day.endTime}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Off</span>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog — responsive */}
      <AttendanceFormShell
        open={showDialog}
        onOpenChange={setShowDialog}
        entity="work-schedule"
        mode={editingId ? "edit" : "create"}
        busy={saveMutation.isPending}
        submitDisabled={!formName.trim()}
        submitLabel="Save Schedule"
        onSubmit={() => saveMutation.mutate()}
      >
        <WorkflowSheetSection number={1} title="Identity" subtitle="How this schedule appears when assigned to employees.">
          <WorkflowField label="Schedule name" required>
            <Input value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g., Standard Mon–Fri" />
          </WorkflowField>
        </WorkflowSheetSection>

        <WorkflowSheetSection
          number={2}
          title="Daily schedule"
          subtitle={<>Weekly hours: <strong className="text-foreground">{calcHours(formDays).toFixed(1)}</strong></>}
        >
          <ScrollArea className="max-h-[55vh] -mx-1 px-1">
            <div className="space-y-3">
              {formDays.map((day, i) => (
                <div key={day.day} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="w-12 text-sm font-medium">{day.day.slice(0, 3)}</div>
                    <Switch checked={day.isWorkDay} onCheckedChange={v => updateDay(i, { isWorkDay: v })} />
                    <span className="text-sm text-muted-foreground">{day.isWorkDay ? "Working day" : "Day off"}</span>
                  </div>
                  {day.isWorkDay && (
                    <div className="grid grid-cols-3 gap-2 pl-[3.75rem]">
                      <div>
                        <Label className="text-xs text-muted-foreground">Start</Label>
                        <Input type="time" value={day.startTime} onChange={e => updateDay(i, { startTime: e.target.value })} className="h-8" />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">End</Label>
                        <Input type="time" value={day.endTime} onChange={e => updateDay(i, { endTime: e.target.value })} className="h-8" />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Break (min)</Label>
                        <Input type="number" value={day.breakMinutes} onChange={e => updateDay(i, { breakMinutes: parseInt(e.target.value) || 0 })} className="h-8" />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </WorkflowSheetSection>
      </AttendanceFormShell>
    </div>
  );
}

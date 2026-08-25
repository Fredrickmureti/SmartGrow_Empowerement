import { normalizeError } from "@/services/resilience";
/**
 * ProjectsConfiguration — runtime-used Project settings.
 *
 * Two interactive sections backed by real columns on `projects`:
 *  - Stage templates per project (`project_stages`)
 *  - Pricing & billing per project (`projects.pricing_type`, `is_billable`,
 *    `hourly_rate`, `currency`, `allow_timesheets`)
 *
 * No decorative toggles. Every control writes to the DB.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useProjects } from "@/hooks/projects";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Trash2, Save } from "lucide-react";
import { ProjectTemplatesCard } from "@/components/projects/ProjectTemplatesCard";

interface Stage { id: string; project_id: string; name: string; sequence: number; is_closed: boolean; color: string | null; }

/**
 * The pricing model is the single decision. Everything else in this card is a
 * consequence of it: whether the project is billable at all, whether a rate is
 * meaningful, and where the rate is actually resolved from at billing time.
 */
type RateMode = "none" | "default" | "fallback";

const PRICING_OPTIONS: {
  value: string;
  label: string;
  billable: boolean;
  rateMode: RateMode;
  rateLabel?: string;
  help: string;
}[] = [
  {
    value: "non_billable",
    label: "Non-billable",
    billable: false,
    rateMode: "none",
    help: "Time and costs are tracked for reporting only. Nothing on this project can be invoiced.",
  },
  {
    value: "employee_rate",
    label: "Employee rate",
    billable: true,
    rateMode: "fallback",
    rateLabel: "Fallback hourly rate",
    help: "Each team member's own billable rate is used. The fallback applies only to members with no rate of their own.",
  },
  {
    value: "task_rate",
    label: "Task rate",
    billable: true,
    rateMode: "fallback",
    rateLabel: "Fallback hourly rate",
    help: "Each task carries its own rate. The fallback applies to tasks with no rate set.",
  },
  {
    value: "project_rate",
    label: "Project rate",
    billable: true,
    rateMode: "default",
    rateLabel: "Project hourly rate",
    help: "One rate for every hour logged on this project, whoever logs it.",
  },
  {
    value: "fixed_price",
    label: "Fixed price",
    billable: true,
    rateMode: "none",
    help: "The agreed contract amount is billed regardless of hours. Set the amount on the project's budget; hours are cost-tracking only.",
  },
  {
    value: "milestone",
    label: "Per milestone",
    billable: true,
    rateMode: "none",
    help: "Revenue is released milestone by milestone. Each milestone carries its own amount and is invoiced when reached.",
  },
];


export default function ProjectsConfiguration() {
  const { projects, refreshProjects, updateProject } = useProjects();
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [newName, setNewName] = useState("");

  // Pricing form state (mirrors selected project)
  const [pricingType, setPricingType] = useState<string>("non_billable");
  const [isBillable, setIsBillable] = useState(false);
  const [allowTimesheets, setAllowTimesheets] = useState(true);
  const [hourlyRate, setHourlyRate] = useState<string>("");
  const [currency, setCurrency] = useState<string>("");
  const [savingPricing, setSavingPricing] = useState(false);

  useEffect(() => {
    if (!selectedProject && projects[0]) setSelectedProject(projects[0].id);
  }, [projects, selectedProject]);

  // Sync pricing form when selection changes
  useEffect(() => {
    const p = projects.find((x) => x.id === selectedProject);
    if (!p) return;
    setPricingType((p as { pricing_type?: string | null }).pricing_type || "non_billable");
    setIsBillable(Boolean(p.is_billable));
    setAllowTimesheets(Boolean((p as { allow_timesheets?: boolean | null }).allow_timesheets ?? true));
    setHourlyRate(p.hourly_rate != null ? String(p.hourly_rate) : "");
    setCurrency((p as { currency?: string | null }).currency || "");
  }, [selectedProject, projects]);

  const refresh = useCallback(async () => {
    if (!selectedProject) return;
    setLoading(true);
    const { data } = await supabase.from("project_stages").select("*").eq("project_id", selectedProject).order("sequence");
    setStages((data ?? []) as Stage[]);
    setLoading(false);
  }, [selectedProject]);

  useEffect(() => { void refresh(); }, [refresh]);

  const addStage = async () => {
    if (!newName.trim() || !selectedProject) return;
    const nextSeq = stages.length > 0 ? Math.max(...stages.map((s) => s.sequence)) + 10 : 10;
    const { error } = await supabase.from("project_stages").insert({ project_id: selectedProject, name: newName.trim(), sequence: nextSeq } as never);
    if (error) { toast.error("Failed to add stage"); return; }
    setNewName("");
    toast.success("Stage added");
    void refresh();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("project_stages").delete().eq("id", id);
    if (error) { toast.error("Failed to delete"); return; }
    void refresh();
  };

  const renameStage = async (id: string, name: string) => {
    if (!name.trim()) return;
    await supabase.from("project_stages").update({ name: name.trim() } as never).eq("id", id);
    void refresh();
  };

  const toggleClosed = async (s: Stage) => {
    await supabase.from("project_stages").update({ is_closed: !s.is_closed } as never).eq("id", s.id);
    void refresh();
  };

  const savePricing = async () => {
    if (!selectedProject) return;
    setSavingPricing(true);
    const patch: Record<string, unknown> = {
      pricing_type: pricingType,
      is_billable: isBillable,
      allow_timesheets: allowTimesheets,
      hourly_rate: hourlyRate ? Number(hourlyRate) : null,
    };
    if (currency.trim()) patch.currency = currency.trim().toUpperCase();
    try {
      // Billing configuration is governed server-side: only an admin or the
      // project manager may change it (project_update_config).
      await updateProject(selectedProject, patch as never);
    } catch (error) {
      toast.error("Failed to save", { description: normalizeError(error).message });
      return;
    } finally {
      setSavingPricing(false);
    }
    void refreshProjects();
  };


  const projectName = useMemo(() => projects.find((p) => p.id === selectedProject)?.name, [projects, selectedProject]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Configuration</h1>
        <p className="text-muted-foreground text-sm">Stages, pricing and runtime rules — all changes persist on the project.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project</CardTitle>
          <CardDescription>Pick a project to manage its stages and pricing.</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger className="w-72"><SelectValue placeholder="Select project" /></SelectTrigger>
            <SelectContent>
              {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stage templates</CardTitle>
          <CardDescription>Stages drive the Kanban board. Closed stages mark tasks as done.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? <Skeleton className="h-32 w-full" /> : projectName ? (
            <div className="space-y-2">
              {stages.length === 0 ? <p className="text-sm text-muted-foreground">No stages yet.</p> : stages.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-md border p-2">
                  <span className="text-xs text-muted-foreground w-10">#{s.sequence}</span>
                  <Input defaultValue={s.name} onBlur={(e) => e.target.value !== s.name && renameStage(s.id, e.target.value)} className="max-w-xs" />
                  <Button variant={s.is_closed ? "default" : "outline"} size="sm" onClick={() => toggleClosed(s)}>
                    {s.is_closed ? "Closed" : "Open"}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(s.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}
              <div className="flex gap-2 pt-2">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New stage name" className="max-w-xs" />
                <Button onClick={addStage}><Plus className="h-4 w-4 mr-1" />Add stage</Button>
              </div>
            </div>
          ) : <p className="text-sm text-muted-foreground">Create a project first.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pricing & billing</CardTitle>
          <CardDescription>Drives how the Financials tab posts revenue and how timesheets are invoiced.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Pricing model</Label>
            <Select value={pricingType} onValueChange={setPricingType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRICING_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Default hourly rate</Label>
            <Input type="number" step="0.01" min="0" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} placeholder="0.00" />
          </div>
          <div className="space-y-1">
            <Label>Currency (ISO)</Label>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="USD" maxLength={3} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Billable project</Label>
              <p className="text-xs text-muted-foreground">Costs and revenue post to the analytic ledger.</p>
            </div>
            <Switch checked={isBillable} onCheckedChange={setIsBillable} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Allow timesheets</Label>
              <p className="text-xs text-muted-foreground">Employees can log time on this project.</p>
            </div>
            <Switch checked={allowTimesheets} onCheckedChange={setAllowTimesheets} />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button onClick={savePricing} disabled={savingPricing || !selectedProject}>
              <Save className="h-4 w-4 mr-1" />{savingPricing ? "Saving…" : "Save pricing"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ProjectTemplatesCard />
    </div>
  );
}

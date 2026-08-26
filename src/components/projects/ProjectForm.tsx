/**
 * ProjectForm — create a new project.
 *
 * Pass 6 — Projects: migrated from tabbed `Dialog` to sectioned `WorkflowSheet`
 * so the experience matches the New Payroll Run standard. All persistence,
 * validation, permission checks and side effects are preserved verbatim.
 */
import { useState, useMemo, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, X, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useProjects } from "@/hooks/projects";
import { useContacts } from "@/hooks/useContacts";
import { useEmployees } from "@/hooks/useEmployees";
import { toast } from "sonner";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { usePermissions } from "@/hooks/usePermissions";
import { useBusinessCurrencies } from "@/hooks/useBusinessCurrencies";

interface ProjectFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PROJECT_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];


type ProjectStatus = "draft" | "active" | "on_hold" | "completed" | "cancelled";
type PricingType = "non_billable" | "employee_rate" | "task_rate" | "project_rate" | "fixed_price" | "milestone";
type Privacy = "public" | "team" | "private";

export function ProjectForm({ open, onOpenChange }: ProjectFormProps) {
  const { createProject } = useProjects();
  const { can } = usePermissions();
  const canCreate = can("manageProjects");
  const { currentOrg } = useOrganization();

  interface TemplateOption {
    id: string;
    name: string;
    default_billable: boolean | null;
    default_currency: string | null;
  }
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateId, setTemplateId] = useState<string>("");

  useEffect(() => {
    if (!open || !currentOrg) return;
    (async () => {
      // A template bound to another business is refused by
      // apply_project_template, so it must not be offered here.
      let q = supabase
        .from("project_templates")
        .select("id, name, default_billable, default_currency")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);
      if (currentBusiness?.id) q = q.or(`business_id.is.null,business_id.eq.${currentBusiness.id}`);
      const { data } = await q.order("name");
      setTemplates((data ?? []) as TemplateOption[]);
    })();
  }, [open, currentOrg, currentBusiness?.id]);


  const { contacts } = useContacts();
  const { employees } = useEmployees();

  const customers = useMemo(
    () => (contacts || []).filter((c) => c.type === "customer" || c.type === "both"),
    [contacts]
  );

  // General
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [isTemplate, setIsTemplate] = useState(false);

  // Customer & Billing
  const [customerId, setCustomerId] = useState<string>("");
  const [pricingType, setPricingType] = useState<PricingType>("non_billable");
  // Tenant-governed: the server rejects any currency not enabled for this business.
  const { currencyCodes, baseCurrency, isLoading: currenciesLoading } = useBusinessCurrencies();
  const [currency, setCurrency] = useState("");

  // Default to the business base currency once the tenant list resolves.
  useEffect(() => {
    if (!currency && baseCurrency) setCurrency(baseCurrency);
  }, [baseCurrency, currency]);
  

  // Schedule
  const [startDate, setStartDate] = useState<Date>();
  const [endDate, setEndDate] = useState<Date>();

  // Budget
  const [budget, setBudget] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [allocatedHours, setAllocatedHours] = useState("");

  // Team & Privacy
  const [managerId, setManagerId] = useState<string>("");
  const [privacy, setPrivacy] = useState<Privacy>("team");

  // Tags
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);

  const isBillable = pricingType !== "non_billable";

  const validation = useMemo(() => {
    const errs: string[] = [];
    if (!name.trim()) errs.push("Project name is required.");
    if (isBillable && !customerId) errs.push("Billable projects must have a customer.");
    if (pricingType === "fixed_price" && !budget) errs.push("Fixed-price projects need a budget.");
    if ((pricingType === "employee_rate" || pricingType === "project_rate") && !hourlyRate) {
      errs.push("Rate-based pricing needs an hourly rate.");
    }
    if (startDate && endDate && endDate < startDate) errs.push("End date is before start date.");
    return errs;
  }, [name, isBillable, customerId, pricingType, budget, hourlyRate, startDate, endDate]);

  const resetForm = () => {
    setName(""); setDescription(""); setStatus("active"); setColor(PROJECT_COLORS[0]);
    setIsTemplate(false);
    setTemplateId("");
    setCustomerId(""); setPricingType("non_billable"); setCurrency("USD");
    setStartDate(undefined); setEndDate(undefined);
    setBudget(""); setHourlyRate(""); setAllocatedHours("");
    setManagerId(""); setPrivacy("team");
    setTags([]); setTagDraft("");
  };

  const addTag = () => {
    const t = tagDraft.trim();
    if (!t || tags.includes(t)) return;
    setTags([...tags, t]); setTagDraft("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validation.length || !canCreate) return;
    setIsSubmitting(true);
    try {
      await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        color,
        is_template: isTemplate,
        template_id: templateId || undefined,
        project_type: customerId ? "client" : "internal",
        customer_id: customerId || undefined,
        pricing_type: pricingType,
        currency,
        
        is_billable: isBillable,
        start_date: startDate ? format(startDate, "yyyy-MM-dd") : undefined,
        end_date: endDate ? format(endDate, "yyyy-MM-dd") : undefined,
        budget: budget ? parseFloat(budget) : undefined,
        budget_type:
          pricingType === "fixed_price" ? "fixed" :
          pricingType === "non_billable" ? "none" : "hourly",
        hourly_rate: hourlyRate ? parseFloat(hourlyRate) : undefined,
        allocated_hours: allocatedHours ? parseFloat(allocatedHours) : undefined,
        manager_id: managerId || undefined,
        privacy,
        tags: tags.length ? tags : undefined,
      });
      onOpenChange(false);
      resetForm();
    } catch (error) {
      console.error("Error creating project:", error);
      toast.error("Failed to create project");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}
      size="2xl"
      title="Create new project"
      description="Configure the project across identity, billing, schedule, team and tags. All fields persist to the project record."
      onSubmit={handleSubmit}
      banner={
        validation.length > 0 ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive mb-1">
              <AlertTriangle className="h-4 w-4" /> Fix the following before creating:
            </div>
            <ul className="list-disc pl-5 space-y-0.5 text-destructive">
              {validation.map((m) => <li key={m}>{m}</li>)}
            </ul>
          </div>
        ) : null
      }
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={isSubmitting || validation.length > 0 || !canCreate}>
            {isSubmitting ? "Creating..." : "Create project"}
          </Button>
        </>
      }
    >
      {templates.length > 0 && (
        <WorkflowSheetSection number={1} title="Template" subtitle="Optional — clone stages, tasks and milestones from an existing template.">
          <WorkflowField label="Start from template">
            <Select value={templateId || "none"} onValueChange={(v) => setTemplateId(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="No template" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Blank project —</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>
      )}

      <WorkflowSheetSection number={templates.length > 0 ? 2 : 1} title="Identity">
        <WorkflowField label="Project name" htmlFor="name" required>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Website Redesign" autoFocus required />
        </WorkflowField>
        <WorkflowField label="Description" htmlFor="description">
          <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief project description" rows={3} />
        </WorkflowField>
        <WorkflowSheetGrid>
          <WorkflowField label="Status">
            <Select value={status} onValueChange={(v: ProjectStatus) => setStatus(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="on_hold">On Hold</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Color">
            <div className="flex flex-wrap gap-2 pt-1">
              {PROJECT_COLORS.map((c) => (
                <button key={c} type="button"
                  aria-label={`Color ${c}`}
                  className={cn("w-7 h-7 rounded-full border-2 transition-transform",
                    color === c ? "scale-110 border-foreground" : "border-transparent hover:scale-105")}
                  style={{ backgroundColor: c }} onClick={() => setColor(c)} />
              ))}
            </div>
          </WorkflowField>
        </WorkflowSheetGrid>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="space-y-0.5">
            <div className="text-sm font-medium">Use as template</div>
            <p className="text-xs text-muted-foreground">Templates can be cloned to bootstrap new projects with the same stages and settings.</p>
          </div>
          <Switch checked={isTemplate} onCheckedChange={setIsTemplate} />
        </div>
      </WorkflowSheetSection>

      <WorkflowSheetGrid>
        <WorkflowSheetSection number={templates.length > 0 ? 3 : 2} title="Billing">
          <WorkflowField label={isBillable ? "Customer" : "Customer (optional)"} required={isBillable}>
            <Select value={customerId || "none"} onValueChange={(v) => setCustomerId(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="Select a customer" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Internal project (no customer) —</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}{c.company ? ` · ${c.company}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowSheetGrid>
            <WorkflowField label="Pricing model">
              <Select value={pricingType} onValueChange={(v: PricingType) => setPricingType(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="non_billable">Non-billable</SelectItem>
                  <SelectItem value="employee_rate">Employee rate</SelectItem>
                  <SelectItem value="project_rate">Project rate</SelectItem>
                  <SelectItem value="task_rate">Task rate</SelectItem>
                  <SelectItem value="fixed_price">Fixed price</SelectItem>
                  <SelectItem value="milestone">Per milestone</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Currency">
              <Select value={currency} onValueChange={setCurrency} disabled={currenciesLoading || currencyCodes.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={currenciesLoading ? "Loading…" : "Select currency"} />
                </SelectTrigger>
                <SelectContent>
                  {currencyCodes.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                      {c === baseCurrency ? " (base)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
          <p className="text-xs text-muted-foreground">
            Finance analytic account: created automatically for this project — costs and
            revenues tagged to it post straight to the analytic ledger.
          </p>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={templates.length > 0 ? 4 : 3} title="Schedule & budget">
          <WorkflowSheetGrid>
            <WorkflowField label="Start date">
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className={cn("w-full justify-start text-left font-normal", !startDate && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {startDate ? format(startDate, "MMM d, yyyy") : "Pick date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={startDate} onSelect={setStartDate} initialFocus />
                </PopoverContent>
              </Popover>
            </WorkflowField>
            <WorkflowField label="End date">
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className={cn("w-full justify-start text-left font-normal", !endDate && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {endDate ? format(endDate, "MMM d, yyyy") : "Pick date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={endDate} onSelect={setEndDate} initialFocus />
                </PopoverContent>
              </Popover>
            </WorkflowField>
          </WorkflowSheetGrid>
          <WorkflowSheetGrid columns={3}>
            <WorkflowField label="Budget" htmlFor="budget" required={pricingType === "fixed_price"}>
              <Input id="budget" type="number" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="0.00" />
            </WorkflowField>
            <WorkflowField label="Hourly rate" htmlFor="rate">
              <Input id="rate" type="number" step="0.01" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} placeholder="0.00" />
            </WorkflowField>
            <WorkflowField label="Allocated hours" htmlFor="hours">
              <Input id="hours" type="number" step="0.5" value={allocatedHours} onChange={(e) => setAllocatedHours(e.target.value)} placeholder="100" />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </WorkflowSheetGrid>

      <WorkflowSheetSection number={templates.length > 0 ? 5 : 4} title="Team & access">
        <WorkflowSheetGrid>
          <WorkflowField label="Project manager">
            <Select value={managerId || "none"} onValueChange={(v) => setManagerId(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="Select manager" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No manager assigned —</SelectItem>
                {(employees || []).filter((e) => e.is_active).map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.first_name} {e.last_name}{e.position ? ` · ${e.position}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Privacy">
            <Select value={privacy} onValueChange={(v: Privacy) => setPrivacy(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public — visible to anyone in the org</SelectItem>
                <SelectItem value="team">Team — visible to project members + admins</SelectItem>
                <SelectItem value="private">Private — restricted to project members</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={templates.length > 0 ? 6 : 5} title="Tags & custom fields">
        <WorkflowField label="Project tags">
          <div className="flex gap-2">
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              placeholder="Type a tag and press Enter"
            />
            <Button type="button" variant="outline" onClick={addTag}>Add</Button>
          </div>
          <div className="flex flex-wrap gap-2 pt-2 min-h-8">
            {tags.length === 0 && <p className="text-xs text-muted-foreground">No tags yet.</p>}
            {tags.map((t) => (
              <Badge key={t} variant="secondary" className="gap-1">
                {t}
                <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} className="hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        </WorkflowField>
        <CustomFieldsSection
          entityType="project"
          entityId={null}
          formValues={{ name, description, status, color, allocatedHours, pricingType, customerId, currency }}
          disabled={isSubmitting}
        />
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

import { normalizeError } from "@/services/resilience";
/**
 * ProjectTemplatesCard — list / create / delete project_templates rows.
 *
 * Templates are applied to a project via `apply_project_template(template_id,
 * project_id)`, which clones `default_stages`, `default_milestones` and
 * `default_tasks` onto the new project. A template therefore has to *carry*
 * that content: `project_create` skips the built-in four-stage board whenever a
 * template is supplied, so an empty template would leave a project with no
 * stages at all. That is why at least one stage is required here.
 *
 * Currency is a tenant-governed value (`list_business_active_currencies`), not
 * free text — the server rejects a project currency that is not enabled for the
 * business, so a template must not be able to seed an invalid one.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBusinessCurrencies } from "@/hooks/useBusinessCurrencies";
import { toast } from "sonner";

interface Template {
  id: string;
  name: string;
  description: string | null;
  default_billable: boolean;
  default_currency: string | null;
  is_active: boolean;
  business_id: string | null;
  default_stages: unknown;
  default_tasks: unknown;
  default_milestones: unknown;
}

/** One entry per non-empty line. */
const parseLines = (raw: string): string[] =>
  raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

export function ProjectTemplatesCard() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currencyCodes, baseCurrency, isLoading: currenciesLoading } = useBusinessCurrencies();

  const [rows, setRows] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [billable, setBillable] = useState(true);
  const [currency, setCurrency] = useState("");
  const [stagesText, setStagesText] = useState("To Do\nIn Progress\nReview\nDone");
  const [tasksText, setTasksText] = useState("");
  const [milestonesText, setMilestonesText] = useState("");
  const [saving, setSaving] = useState(false);

  // Default to the business base currency once the tenant list resolves.
  useEffect(() => {
    if (!currency && baseCurrency) setCurrency(baseCurrency);
  }, [baseCurrency, currency]);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    let q = supabase
      .from("project_templates")
      .select(
        "id, name, description, default_billable, default_currency, is_active, business_id, default_stages, default_tasks, default_milestones",
      )
      .eq("organization_id", currentOrg.id);
    // A template bound to another business can never be applied
    // (`apply_project_template` refuses it), so it must not be listed here.
    if (currentBusiness?.id) q = q.or(`business_id.is.null,business_id.eq.${currentBusiness.id}`);
    const { data, error } = await q.order("name");
    if (error) toast.error(normalizeError(error).message);
    setRows((data ?? []) as Template[]);
    setLoading(false);
  }, [currentOrg, currentBusiness?.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const stages = useMemo(() => parseLines(stagesText), [stagesText]);

  const create = async () => {
    if (!currentOrg || !name.trim()) return;
    if (stages.length === 0) {
      toast.error("Add at least one stage", {
        description: "A project created from this template would otherwise have no board stages.",
      });
      return;
    }
    if (billable && !currency) {
      toast.error("Pick a default currency for a billable template");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("project_templates").insert({
      organization_id: currentOrg.id,
      business_id: currentBusiness?.id ?? null,
      name: name.trim(),
      description: desc.trim() || null,
      default_billable: billable,
      default_currency: billable ? currency || null : null,
      // Shapes consumed by apply_project_template().
      default_stages: stages.map((s, i) => ({
        name: s,
        sequence: i * 10,
        is_closed: i === stages.length - 1,
      })),
      default_tasks: parseLines(tasksText).map((t) => ({ name: t })),
      default_milestones: parseLines(milestonesText).map((m) => ({ name: m })),
      default_tags: [],
      is_active: true,
    } as never);
    setSaving(false);
    if (error) { toast.error(normalizeError(error).message); return; }
    setName(""); setDesc(""); setTasksText(""); setMilestonesText("");
    toast.success("Template created");
    await refresh();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("project_templates").delete().eq("id", id);
    if (error) { toast.error(normalizeError(error).message); return; }
    toast.success("Template deleted");
    await refresh();
  };

  const toggleActive = async (t: Template) => {
    const { error } = await supabase
      .from("project_templates")
      .update({ is_active: !t.is_active } as never)
      .eq("id", t.id);
    if (error) { toast.error(normalizeError(error).message); return; }
    await refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Project templates</CardTitle>
        <CardDescription>
          Reusable starting points. Choosing a template on the project create form clones its
          stages, milestones and tasks, and seeds the billing defaults.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 rounded-md border p-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Construction phase 1" />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" />
          </div>

          <div className="space-y-1">
            <Label>Stages (one per line)</Label>
            <Textarea rows={4} value={stagesText} onChange={(e) => setStagesText(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Order is kept; the last stage is treated as the closing stage. Required — projects
              created from a template do not get the default board.
            </p>
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Milestones (one per line)</Label>
              <Textarea rows={2} value={milestonesText} onChange={(e) => setMilestonesText(e.target.value)} placeholder="Optional" />
            </div>
            <div className="space-y-1">
              <Label>Starter tasks (one per line)</Label>
              <Textarea rows={2} value={tasksText} onChange={(e) => setTasksText(e.target.value)} placeholder="Optional" />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border p-2">
            <div>
              <Label className="text-sm">Billable by default</Label>
              <p className="text-xs text-muted-foreground">Pre-selects a billable pricing model on new projects.</p>
            </div>
            <Switch checked={billable} onCheckedChange={setBillable} />
          </div>
          {billable && (
            <div className="space-y-1">
              <Label>Default currency</Label>
              <Select value={currency} onValueChange={setCurrency} disabled={currenciesLoading || currencyCodes.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={currenciesLoading ? "Loading…" : "Select currency"} />
                </SelectTrigger>
                <SelectContent>
                  {currencyCodes.map((c) => (
                    <SelectItem key={c} value={c}>{c}{c === baseCurrency ? " (base)" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="sm:col-span-2 flex justify-end">
            <Button onClick={create} disabled={saving || !name.trim()}>
              <Plus className="h-4 w-4 mr-1" /> {saving ? "Saving…" : "Create template"}
            </Button>
          </div>
        </div>

        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No templates yet.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((t) => {
              const stageCount = countOf(t.default_stages);
              return (
                <div key={t.id} className="flex items-center justify-between rounded-md border p-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{t.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {stageCount} stage{stageCount === 1 ? "" : "s"} · {countOf(t.default_milestones)} milestones ·{" "}
                      {countOf(t.default_tasks)} tasks ·{" "}
                      {t.default_billable ? `Billable${t.default_currency ? ` (${t.default_currency})` : ""}` : "Non-billable"}
                    </div>
                    {stageCount === 0 && (
                      <p className="text-xs text-destructive">
                        No stages — a project created from this template starts with an empty board.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={t.is_active} onCheckedChange={() => toggleActive(t)} />
                    <Button variant="ghost" size="icon" onClick={() => remove(t.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

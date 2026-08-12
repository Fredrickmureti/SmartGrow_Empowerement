import { normalizeError } from "@/services/resilience";
/**
 * ProjectTemplatesCard — list / create / delete project_templates rows.
 *
 * Templates are applied to a project via the existing
 * `apply_project_template(template_id, project_id)` RPC (called from the
 * project create form). This card just manages the catalog.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

interface Template {
  id: string;
  name: string;
  description: string | null;
  default_billable: boolean;
  default_currency: string | null;
  is_active: boolean;
  default_stages: unknown;
  default_tasks: unknown;
}

export function ProjectTemplatesCard() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [rows, setRows] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [billable, setBillable] = useState(true);
  const [currency, setCurrency] = useState(currentBusiness?.base_currency ?? "");
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    if (!currentOrg) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("project_templates")
      .select("id, name, description, default_billable, default_currency, is_active, default_stages, default_tasks")
      .eq("organization_id", currentOrg.id)
      .order("name");
    if (error) toast.error(normalizeError(error).message);
    setRows((data ?? []) as Template[]);
    setLoading(false);
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [currentOrg?.id]);

  const create = async () => {
    if (!currentOrg || !name.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("project_templates").insert({
      organization_id: currentOrg.id,
      business_id: currentBusiness?.id ?? null,
      name: name.trim(),
      description: desc.trim() || null,
      default_billable: billable,
      default_currency: currency.trim().toUpperCase() || null,
      default_stages: [],
      default_tasks: [],
      default_milestones: [],
      default_tags: [],
      is_active: true,
    } as never);
    setSaving(false);
    if (error) { toast.error(normalizeError(error).message); return; }
    setName(""); setDesc("");
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
        <CardDescription>Reusable starting points (default stages, tasks, billing). Applied via the project create form.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-5 items-end rounded-md border p-3">
          <div className="sm:col-span-2 space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Construction phase 1" />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label>Description</Label>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" />
          </div>
          <div className="space-y-1">
            <Label>Currency</Label>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
          </div>
          <div className="flex items-center justify-between sm:col-span-2 rounded-md border p-2">
            <Label className="text-sm">Billable by default</Label>
            <Switch checked={billable} onCheckedChange={setBillable} />
          </div>
          <div className="sm:col-span-3 flex justify-end">
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
            {rows.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-md border p-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{t.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {t.description || "—"} · {t.default_currency ?? "—"} · {t.default_billable ? "Billable" : "Non-billable"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={t.is_active} onCheckedChange={() => toggleActive(t)} />
                  <Button variant="ghost" size="icon" onClick={() => remove(t.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

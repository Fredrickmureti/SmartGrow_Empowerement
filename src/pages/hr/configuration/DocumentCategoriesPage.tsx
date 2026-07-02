import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { HrConfigFormShell } from "@/components/hr/configuration/_shared/HrConfigFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Plus, Trash2, FileText } from "lucide-react";
import { toast } from "sonner";
import { ConfigPageHeader } from "./_ConfigShell";

interface Cat { id: string; code: string; name: string; description: string | null; is_required_for_onboarding: boolean; retention_days: number | null; sort_order: number; is_active: boolean }

export default function DocumentCategoriesPage() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: cats = [], isLoading } = useQuery({
    queryKey: ["hr-doc-cats", currentBusiness?.id],
    queryFn: async (): Promise<Cat[]> => {
      if (!currentBusiness?.id) return [];
      const { data, error } = await supabase.from("hr_document_categories").select("*").eq("business_id", currentBusiness.id).order("sort_order");
      if (error) throw error;
      return (data || []) as any;
    },
    enabled: !!currentBusiness?.id,
  });

  const save = useMutation({
    mutationFn: async (input: Partial<Cat> & { code: string; name: string }) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("Select a business first");
      const payload: any = { organization_id: currentOrg.id, business_id: currentBusiness.id, ...input };
      const { error } = await supabase.from("hr_document_categories").upsert(payload, { onConflict: "business_id,code" });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hr-doc-cats"] }); toast.success("Saved"); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("hr_document_categories").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hr-doc-cats"] }),
  });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", retention_days: "", is_required_for_onboarding: false });

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ConfigPageHeader
        title="Document categories"
        subtitle="Taxonomy used to classify files stored on the employee record (contracts, IDs, certificates, etc.)."
        action={<Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4 mr-1" /> New category</Button>}
      />

      {cats.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No categories yet. Common starters: Contracts, IDs, Certificates, Tax Forms.</CardContent></Card>
      ) : (
        <div className="space-y-1">
          {cats.map((c) => (
            <Card key={c.id}><CardContent className="p-3 grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 items-center">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">{c.name} <code className="text-xs text-muted-foreground ml-1">{c.code}</code></div>
                {c.description && <div className="text-xs text-muted-foreground">{c.description}</div>}
              </div>
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox checked={c.is_required_for_onboarding} onCheckedChange={(v) => save.mutate({ ...c, is_required_for_onboarding: !!v })} />
                Required for onboarding
              </label>
              <span className="text-xs text-muted-foreground">{c.retention_days ? `${c.retention_days}d retention` : "no retention"}</span>
              <Button variant="ghost" size="icon" onClick={() => { if (confirm("Delete category?")) remove.mutate(c.id); }}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </CardContent></Card>
          ))}
        </div>
      )}

      <HrConfigFormShell
        open={adding}
        onOpenChange={setAdding}
        entity="document-category"
        busy={save.isPending}
        submitDisabled={!form.name || !form.code}
        onSubmit={async () => {
          await save.mutateAsync({ code: form.code, name: form.name, retention_days: form.retention_days ? +form.retention_days : null, is_required_for_onboarding: form.is_required_for_onboarding });
          setAdding(false);
          setForm({ code: "", name: "", retention_days: "", is_required_for_onboarding: false });
        }}
      >
        <WorkflowSheetSection number={1} title="Identity" subtitle="Visible label and a short stable code used in integrations.">
          <WorkflowSheetGrid>
            <WorkflowField label="Name" required>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Employment Contracts" />
            </WorkflowField>
            <WorkflowField label="Code" required>
              <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") }))} placeholder="contracts" />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Retention & onboarding" subtitle="Drives onboarding checklists and document lifecycle policies.">
          <WorkflowSheetGrid>
            <WorkflowField label="Retention (days)" hint="Optional. Leave blank to retain indefinitely.">
              <Input type="number" value={form.retention_days} onChange={(e) => setForm((f) => ({ ...f, retention_days: e.target.value }))} placeholder="e.g. 2555" />
            </WorkflowField>
            <WorkflowField label="Required during onboarding">
              <label className="flex items-center gap-2 text-sm h-9">
                <Checkbox checked={form.is_required_for_onboarding} onCheckedChange={(v) => setForm((f) => ({ ...f, is_required_for_onboarding: !!v }))} />
                Required before onboarding completes
              </label>
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </HrConfigFormShell>
    </div>
  );
}

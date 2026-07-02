import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HrConfigFormShell } from "@/components/hr/configuration/_shared/HrConfigFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Plus, Trash2, GraduationCap } from "lucide-react";
import { toast } from "sonner";
import { ConfigPageHeader } from "./_ConfigShell";

export default function CompetenciesPage() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["competencies", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase.from("competencies").select("*").eq("organization_id", currentOrg.id).order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: !!currentOrg?.id,
  });

  const create = useMutation({
    mutationFn: async (input: { name: string; category: string; description: string }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { error } = await supabase.from("competencies").insert({ organization_id: currentOrg.id, ...input } as any);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["competencies"] }); toast.success("Created"); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("competencies").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["competencies"] }),
  });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", category: "technical", description: "" });

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ConfigPageHeader
        title="Competencies"
        subtitle="Skills catalog. Assign competencies to employees on their profile to track strengths and training gaps."
        action={<Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4 mr-1" /> New competency</Button>}
      />

      {items.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No competencies yet.</CardContent></Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-2">
          {items.map((c: any) => (
            <Card key={c.id}><CardContent className="p-3 flex items-center gap-3">
              <GraduationCap className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{c.name}</div>
                <div className="text-xs text-muted-foreground">{c.category || "—"}{c.description ? ` · ${c.description}` : ""}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => { if (confirm("Delete?")) remove.mutate(c.id); }}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </CardContent></Card>
          ))}
        </div>
      )}

      <HrConfigFormShell
        open={adding}
        onOpenChange={setAdding}
        entity="competency"
        busy={create.isPending}
        submitDisabled={!form.name.trim()}
        onSubmit={async () => {
          await create.mutateAsync(form);
          setForm({ name: "", category: "technical", description: "" });
          setAdding(false);
        }}
      >
        <WorkflowSheetSection number={1} title="Identity" subtitle="Name and category surface this competency across reviews and development plans.">
          <WorkflowSheetGrid>
            <WorkflowField label="Name" required>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Stakeholder Communication" />
            </WorkflowField>
            <WorkflowField label="Category">
              <Input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="technical / leadership / behavioural" />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Description" subtitle="Optional. Reviewers and employees see this when rating.">
          <Textarea rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="What does mastery of this competency look like?" />
        </WorkflowSheetSection>
      </HrConfigFormShell>
    </div>
  );
}

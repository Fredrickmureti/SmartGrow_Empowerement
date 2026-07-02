import { useState } from "react";
import { Link } from "react-router-dom";
import { useOnboardingTemplates } from "@/hooks/useOnboarding";
import { useOnboardingTemplate } from "@/hooks/hr/useOnboardingTemplate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HrConfigFormShell } from "@/components/hr/configuration/_shared/HrConfigFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, ClipboardList, Trash2, Loader2 } from "lucide-react";
import { ConfigPageHeader } from "./_ConfigShell";

export default function OnboardingTemplatesPage() {
  const { templates, isLoading, deleteTemplate } = useOnboardingTemplates();
  const { createTemplate } = useOnboardingTemplate(undefined);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", template_type: "onboarding" });

  const submit = async () => {
    if (!form.name.trim()) return;
    await createTemplate.mutateAsync(form);
    setForm({ name: "", description: "", template_type: "onboarding" });
    setOpen(false);
  };

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-4">
      <ConfigPageHeader
        title="Onboarding & offboarding templates"
        subtitle="Reusable checklists. Set a template as default in HR Defaults to auto-apply on hire."
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New template
          </Button>
        }
      />

      {templates.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          No templates yet. Create your first onboarding checklist.
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <Card key={t.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="p-4 flex items-center gap-3">
                <ClipboardList className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link to={t.id} className="font-medium hover:underline truncate">{t.name}</Link>
                    <Badge variant={t.template_type === "onboarding" ? "default" : "secondary"} className="text-xs">
                      {t.template_type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{t.items?.length ?? 0} items</span>
                  </div>
                  {t.description && <p className="text-xs text-muted-foreground truncate">{t.description}</p>}
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link to={t.id}>Edit</Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (confirm(`Delete template "${t.name}"?`)) deleteTemplate.mutate(t.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <HrConfigFormShell
        open={open}
        onOpenChange={setOpen}
        entity="onboarding-template"
        busy={createTemplate.isPending}
        submitDisabled={!form.name.trim()}
        onSubmit={submit}
      >
        <WorkflowSheetSection number={1} title="Identity" subtitle="Pick a clear name and the lifecycle this template belongs to.">
          <WorkflowSheetGrid>
            <WorkflowField label="Name" required>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Standard Onboarding" />
            </WorkflowField>
            <WorkflowField label="Type" required>
              <Select value={form.template_type} onValueChange={(v) => setForm((f) => ({ ...f, template_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="onboarding">Onboarding</SelectItem>
                  <SelectItem value="offboarding">Offboarding</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Description" subtitle="Visible on the template list and to assignees on the checklist.">
          <Textarea rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="What is this template for? When should HR pick it?" />
        </WorkflowSheetSection>
      </HrConfigFormShell>
    </div>
  );
}

function Spinner() {
  return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
}


import { useState } from "react";
import { useEmployeeOnboarding, useOnboardingTemplates } from "@/hooks/useOnboarding";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { WorkflowSheet, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ClipboardList, Loader2, Plus, CheckCircle2, Clock } from "lucide-react";
import { format } from "date-fns";

interface EmployeeOnboardingTabProps {
  employeeId: string;
  canEdit?: boolean;
}

export function EmployeeOnboardingTab({ employeeId, canEdit = false }: EmployeeOnboardingTabProps) {
  const { onboardings, isLoading, startOnboarding, toggleItem, completeOnboarding } = useEmployeeOnboarding(employeeId);
  const { templates } = useOnboardingTemplates();
  const [showStart, setShowStart] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [selectedType, setSelectedType] = useState("onboarding");

  const handleStart = async () => {
    if (!selectedTemplate) return;
    await startOnboarding.mutateAsync({ templateId: selectedTemplate, type: selectedType });
    setShowStart(false);
    setSelectedTemplate("");
  };

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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Onboarding / Offboarding</h3>
        {canEdit && (
          <Button size="sm" onClick={() => setShowStart(true)}>
            <Plus className="h-4 w-4 mr-1" /> Start Process
          </Button>
        )}
      </div>

      {onboardings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <ClipboardList className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No onboarding or offboarding processes started.</p>
          </CardContent>
        </Card>
      ) : (
        onboardings.map((ob) => {
          const items = ob.items || [];
          const completedCount = items.filter(i => i.is_completed).length;
          const progress = items.length > 0 ? Math.round((completedCount / items.length) * 100) : 0;

          return (
            <Card key={ob.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    {ob.onboarding_type === "onboarding" ? "Onboarding" : "Offboarding"}
                    <Badge variant={ob.status === "completed" ? "default" : "secondary"}>
                      {ob.status === "completed" ? <><CheckCircle2 className="h-3 w-3 mr-1" /> Completed</> : <><Clock className="h-3 w-3 mr-1" /> In Progress</>}
                    </Badge>
                  </CardTitle>
                  {canEdit && ob.status === "in_progress" && progress === 100 && (
                    <Button size="sm" variant="outline" onClick={() => completeOnboarding.mutate(ob.id)}>
                      Mark Complete
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">Started {format(new Date(ob.started_at || ob.created_at), "MMM d, yyyy")}</p>
                {items.length > 0 && (
                  <div className="flex items-center gap-2 mt-2">
                    <Progress value={progress} className="h-2 flex-1" />
                    <span className="text-xs text-muted-foreground">{completedCount}/{items.length}</span>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {items.map((item) => (
                    <div key={item.id} className="flex items-start gap-3 p-2 rounded hover:bg-muted/50">
                      <Checkbox
                        checked={item.is_completed}
                        disabled={!canEdit || ob.status === "completed"}
                        onCheckedChange={(checked) => toggleItem.mutate({ itemId: item.id, completed: !!checked })}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <p className={`text-sm ${item.is_completed ? "line-through text-muted-foreground" : ""}`}>{item.title}</p>
                        {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
                        {item.category !== "general" && <Badge variant="outline" className="text-xs mt-1">{item.category}</Badge>}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      <WorkflowSheet
        open={showStart}
        onOpenChange={setShowStart}
        size="md"
        title="Start Onboarding / Offboarding"
        description="Pick a checklist template to seed the employee's task list."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowStart(false)}>Cancel</Button>
            <Button onClick={handleStart} disabled={!selectedTemplate || startOnboarding.isPending}>
              {startOnboarding.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Start
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Process" subtitle="Choose whether the employee is joining or leaving.">
          <WorkflowField label="Type" required>
            <Select value={selectedType} onValueChange={setSelectedType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="onboarding">Onboarding</SelectItem>
                <SelectItem value="offboarding">Offboarding</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Template" subtitle="Only active templates of the selected type appear.">
          <WorkflowField label="Template" required>
            <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
              <SelectTrigger><SelectValue placeholder="Select a template" /></SelectTrigger>
              <SelectContent>
                {templates
                  .filter(t => t.template_type === selectedType && t.is_active)
                  .map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
          {templates.filter(t => t.template_type === selectedType && t.is_active).length === 0 && (
            <p className="text-xs text-muted-foreground">No {selectedType} templates found. Create one in HR Settings first.</p>
          )}
        </WorkflowSheetSection>
      </WorkflowSheet>

    </div>
  );
}

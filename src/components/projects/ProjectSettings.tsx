import { useState } from "react";
import { Project, ProjectStage } from "@/hooks/projects/useProjects";
import { useProjects } from "@/hooks/projects";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface ProjectSettingsProps {
  project: Project;
  stages: ProjectStage[];
  onUpdate: (updates: Partial<Project>) => Promise<void>;
  onStagesChange: () => Promise<void>;
}

const PROJECT_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

export function ProjectSettings({ project, stages, onUpdate, onStagesChange }: ProjectSettingsProps) {
  const { createStage, deleteStage, getClosureBlockers } = useProjects();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || "");
  const [status, setStatus] = useState<string>(project.status || "active");
  const [color, setColor] = useState(project.color || "#3b82f6");
  const [allocatedHours, setAllocatedHours] = useState(String(project.allocated_hours || ""));
  const [budget, setBudget] = useState(String(project.budget || ""));
  const [budgetType, setBudgetType] = useState<string>(project.budget_type || "none");
  const [hourlyRate, setHourlyRate] = useState(String(project.hourly_rate || ""));
  const [isBillable, setIsBillable] = useState(project.is_billable || false);
  const [privacy, setPrivacy] = useState<string>(project.privacy || "team");
  const [isSaving, setIsSaving] = useState(false);
  const [newStageName, setNewStageName] = useState("");

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Closing a project is a governed lifecycle event: show the server's
      // blockers up front instead of letting the command fail after the save.
      const isClosing = status !== project.status && (status === "completed" || status === "cancelled");
      if (isClosing) {
        const blockers = await getClosureBlockers(project.id);
        if (blockers.length > 0) {
          toast.error(`This project cannot be closed yet: ${blockers.join("; ")}`);
          return;
        }
      }

      await onUpdate({
        name,
        description: description || null,
        // Only a real transition is sent — re-submitting the current status
        // would be rejected by the server's transition table.
        ...(status !== project.status ? { status: status as Project["status"] } : {}),
        color,
        allocated_hours: allocatedHours ? parseFloat(allocatedHours) : null,
        budget: budget ? parseFloat(budget) : null,
        budget_type: budgetType as Project["budget_type"],
        hourly_rate: hourlyRate ? parseFloat(hourlyRate) : null,
        is_billable: isBillable,
        privacy: privacy as Project["privacy"],
        // Optimistic concurrency — rejected server-side if someone else edited.
        version: project.version,
      });
    } catch {
      // useProjects already surfaced a specific, mapped error message.
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddStage = async () => {
    if (!newStageName.trim()) return;
    try {
      await createStage(project.id, newStageName, stages.length);
      setNewStageName("");
      await onStagesChange();
    } catch {
      toast.error("Failed to add stage");
    }
  };

  const handleDeleteStage = async (stageId: string) => {
    try {
      await deleteStage(stageId);
      await onStagesChange();
    } catch {
      toast.error("Failed to delete stage");
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* General */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Project Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="on_hold">On Hold</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Privacy</Label>
              <Select value={privacy} onValueChange={setPrivacy}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public</SelectItem>
                  <SelectItem value="team">Team Only</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex gap-2 flex-wrap">
              {PROJECT_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${
                    color === c ? "scale-110 border-foreground" : "border-transparent hover:scale-105"
                  }`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Billing & Budget */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Billing & Budget</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Billable Project</Label>
            <Switch checked={isBillable} onCheckedChange={setIsBillable} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Budget Type</Label>
              <Select value={budgetType} onValueChange={setBudgetType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="fixed">Fixed Price</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Budget ($)</Label>
              <Input type="number" value={budget} onChange={e => setBudget(e.target.value)} placeholder="0" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Hourly Rate ($)</Label>
              <Input type="number" value={hourlyRate} onChange={e => setHourlyRate(e.target.value)} placeholder="0" />
            </div>

            <div className="space-y-2">
              <Label>Allocated Hours</Label>
              <Input type="number" value={allocatedHours} onChange={e => setAllocatedHours(e.target.value)} placeholder="0" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Workflow Stages */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workflow Stages</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            {stages.map(s => (
              <div key={s.id} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-2">
                  {s.color && (
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                  )}
                  <span className="text-sm">{s.name}</span>
                  {s.is_closed && (
                    <Badge variant="secondary" className="text-[10px] h-4">closed</Badge>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDeleteStage(s.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              value={newStageName}
              onChange={e => setNewStageName(e.target.value)}
              placeholder="New stage name..."
              onKeyDown={e => e.key === "Enter" && handleAddStage()}
            />
            <Button size="sm" onClick={handleAddStage} disabled={!newStageName.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      <Button onClick={handleSave} disabled={isSaving || !name} className="w-full">
        {isSaving ? "Saving..." : "Save All Changes"}
      </Button>
    </div>
  );
}

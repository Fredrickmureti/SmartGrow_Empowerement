import { useState } from "react";
import { WorkflowSheet, WorkflowSheetSection } from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, GripVertical, Trash2, Edit2, Check, X } from "lucide-react";
import { useCRMStages, CRMStage } from "@/hooks/crm";
import { toast } from "sonner";

interface StageSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_COLORS = [
  "#6b7280", "#3b82f6", "#8b5cf6", "#ec4899",
  "#f59e0b", "#10b981", "#06b6d4", "#ef4444"
];

export function StageSettingsDialog({ open, onOpenChange }: StageSettingsDialogProps) {
  const { stages, createStage, updateStage, deleteStage } = useCRMStages();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editProbability, setEditProbability] = useState("");
  const [editIsWon, setEditIsWon] = useState(false);
  const [editIsLost, setEditIsLost] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newStageName, setNewStageName] = useState("");
  const [newStageColor, setNewStageColor] = useState(DEFAULT_COLORS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleEdit = (stage: CRMStage) => {
    setEditingId(stage.id);
    setEditName(stage.name);
    setEditColor(stage.color || DEFAULT_COLORS[0]);
    setEditProbability(stage.probability?.toString() || "");
    setEditIsWon(stage.is_won || false);
    setEditIsLost(stage.is_lost || false);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return;

    setIsSubmitting(true);
    try {
      await updateStage(editingId, {
        name: editName.trim(),
        color: editColor,
        probability: editProbability ? parseInt(editProbability) : null,
        is_won: editIsWon,
        is_lost: editIsLost,
      });
      setEditingId(null);
    } catch (error) {
      toast.error("Failed to update stage");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditColor("");
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this stage? Leads in this stage will need to be moved.")) {
      return;
    }

    try {
      await deleteStage(id);
    } catch (error) {
      toast.error("Failed to delete stage");
    }
  };

  const handleCreateStage = async () => {
    if (!newStageName.trim()) {
      toast.error("Please enter a stage name");
      return;
    }

    setIsSubmitting(true);
    try {
      const maxSequence = stages.length > 0
        ? Math.max(...stages.map(s => s.sequence))
        : 0;

      await createStage({
        name: newStageName.trim(),
        color: newStageColor,
        sequence: maxSequence + 1,
        probability: 0,
      });

      setNewStageName("");
      setNewStageColor(DEFAULT_COLORS[0]);
      setIsCreating(false);
    } catch (error) {
      toast.error("Failed to create stage");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Pipeline Stage Settings"
      description="Configure your sales pipeline stages. Drag to reorder, or click to edit."
      footer={
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      <WorkflowSheetSection number={1} title="Stages" subtitle={`${stages.length} configured`}>
        {stages.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No stages configured. Add your first stage below.
          </div>
        ) : (
          <div className="space-y-2">
            {stages.map((stage) => (
              <Card key={stage.id} className="relative">
                <CardContent className="p-3">
                  {editingId === stage.id ? (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Stage name"
                          className="flex-1"
                        />
                        <Button size="icon" variant="ghost" onClick={handleSaveEdit} disabled={isSubmitting}>
                          <Check className="h-4 w-4 text-green-600" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={handleCancelEdit}>
                          <X className="h-4 w-4 text-red-600" />
                        </Button>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Label className="text-xs text-muted-foreground w-full">Color</Label>
                        {DEFAULT_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={`w-6 h-6 rounded-full border-2 ${
                              editColor === color ? "border-primary" : "border-transparent"
                            }`}
                            style={{ backgroundColor: color }}
                            onClick={() => setEditColor(color)}
                          />
                        ))}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <Label className="text-xs">Probability (%)</Label>
                          <Input
                            type="number"
                            min="0"
                            max="100"
                            value={editProbability}
                            onChange={(e) => setEditProbability(e.target.value)}
                            placeholder="0-100"
                          />
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Won Stage</Label>
                            <Switch
                              checked={editIsWon}
                              onCheckedChange={(checked) => {
                                setEditIsWon(checked);
                                if (checked) setEditIsLost(false);
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Lost Stage</Label>
                            <Switch
                              checked={editIsLost}
                              onCheckedChange={(checked) => {
                                setEditIsLost(checked);
                                if (checked) setEditIsWon(false);
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab" />
                      <div
                        className="w-4 h-4 rounded-full flex-shrink-0"
                        style={{ backgroundColor: stage.color || "#6b7280" }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{stage.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {stage.probability !== null && `${stage.probability}% probability`}
                          {stage.is_won && " • Won stage"}
                          {stage.is_lost && " • Lost stage"}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" onClick={() => handleEdit(stage)}>
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => handleDelete(stage.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Add stage">
        {isCreating ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={newStageName}
                onChange={(e) => setNewStageName(e.target.value)}
                placeholder="New stage name"
                className="flex-1"
                autoFocus
              />
              <Button size="icon" variant="ghost" onClick={handleCreateStage} disabled={isSubmitting}>
                <Check className="h-4 w-4 text-green-600" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setIsCreating(false);
                  setNewStageName("");
                }}
              >
                <X className="h-4 w-4 text-red-600" />
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              <Label className="text-xs text-muted-foreground w-full">Color</Label>
              {DEFAULT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`w-6 h-6 rounded-full border-2 ${
                    newStageColor === color ? "border-primary" : "border-transparent"
                  }`}
                  style={{ backgroundColor: color }}
                  onClick={() => setNewStageColor(color)}
                />
              ))}
            </div>
          </div>
        ) : (
          <Button variant="outline" className="w-full border-dashed" onClick={() => setIsCreating(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Stage
          </Button>
        )}
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

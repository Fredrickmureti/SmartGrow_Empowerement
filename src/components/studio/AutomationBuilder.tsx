import { useState, useMemo } from "react";
import {
  useAutomations,
  useAutomationSteps,
  AutomatedAction,
  AutomatedActionStep,
  TRIGGER_TYPE_LABELS,
  ACTION_TYPE_LABELS,
  TriggerType,
  ActionType,
} from "@/hooks/useAutomations";
import { ENTITY_TYPE_LABELS, EntityType } from "@/hooks/useEntityFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  Copy,
  Zap,
  Play,
  Pause,
  ChevronRight,
  Clock,
  Mail,
  Bell,
  Webhook,
  FileEdit,
  Loader2,
  Settings,
  ArrowRight,
  Sparkles,
  ShieldAlert,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AutomationTemplateGallery } from "./AutomationTemplateGallery";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { normalizeError } from "@/services/resilience";

const FINANCIAL_MODELS = ["mf_loan", "mf_disbursement", "mf_repayment", "expense"];

const TRIGGER_ICONS: Record<TriggerType, React.ReactNode> = {
  on_create: <Plus className="h-4 w-4" />,
  on_update: <FileEdit className="h-4 w-4" />,
  on_delete: <Trash2 className="h-4 w-4" />,
  time_based: <Clock className="h-4 w-4" />,
  field_change: <Settings className="h-4 w-4" />,
  webhook: <Webhook className="h-4 w-4" />,
  manual: <Play className="h-4 w-4" />,
};

const ACTION_ICONS: Record<ActionType, React.ReactNode> = {
  update_record: <FileEdit className="h-4 w-4" />,
  create_record: <Plus className="h-4 w-4" />,
  send_email: <Mail className="h-4 w-4" />,
  send_notification: <Bell className="h-4 w-4" />,
  webhook_call: <Webhook className="h-4 w-4" />,
  create_activity: <Clock className="h-4 w-4" />,
  add_tag: <Plus className="h-4 w-4" />,
  run_code: <Settings className="h-4 w-4" />,
};

export function AutomationBuilder() {
  const {
    automations,
    isLoading,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    toggleAutomation,
    duplicateAutomation,
    activeAutomations,
    inactiveAutomations,
  } = useAutomations();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showStepsDialog, setShowStepsDialog] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState<AutomatedAction | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [newAutomation, setNewAutomation] = useState({
    name: "",
    description: "",
    trigger_type: "on_create" as TriggerType,
    target_model: "mf_loan" as EntityType,
  });

  const handleCreateAutomation = async () => {
    if (!newAutomation.name.trim()) {
      toast.error("Automation name is required");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await createAutomation({
        name: newAutomation.name,
        description: newAutomation.description || null,
        trigger_type: newAutomation.trigger_type,
        target_model: newAutomation.target_model,
        is_active: false,
        trigger_conditions: [],
        filter_domain: [],
        watched_fields: null,
        schedule_type: null,
        schedule_config: null,
        next_run_at: null,
        last_run_at: null,
        run_as_user_id: null,
        max_retries: 3,
        retry_delay_seconds: 60,
        business_id: null,
      });
      setShowCreateDialog(false);
      setNewAutomation({
        name: "",
        description: "",
        trigger_type: "on_create",
        target_model: "mf_loan",
      });
      // Open steps dialog for the new automation
      setSelectedAutomation(created);
      setShowStepsDialog(true);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to create automation");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteAutomation = async () => {
    if (!selectedAutomation) return;

    setIsSubmitting(true);
    try {
      await deleteAutomation(selectedAutomation.id);
      setShowDeleteDialog(false);
      setSelectedAutomation(null);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to delete automation");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDuplicate = async (automation: AutomatedAction) => {
    try {
      await duplicateAutomation(automation.id);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to duplicate automation");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <Zap className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
            Automations
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Automate tasks and workflows based on triggers and conditions
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Button variant="outline" onClick={() => setShowTemplateGallery(true)} className="w-full sm:w-auto">
            <Sparkles className="mr-2 h-4 w-4" />
            Templates
          </Button>
          <Button onClick={() => setShowCreateDialog(true)} className="w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            Create Automation
          </Button>
        </div>
      </div>

      {automations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Zap className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No automations yet</h3>
            <p className="text-muted-foreground text-center mb-4 text-sm">
              Create your first automation to streamline your workflows
            </p>
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create Automation
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {activeAutomations.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Play className="h-4 w-4 text-green-500" />
                Active ({activeAutomations.length})
              </h3>
              <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {activeAutomations.map((automation) => (
                  <AutomationCard
                    key={automation.id}
                    automation={automation}
                    onToggle={() => toggleAutomation(automation.id, !automation.is_active)}
                    onEdit={() => {
                      setSelectedAutomation(automation);
                      setShowStepsDialog(true);
                    }}
                    onDuplicate={() => handleDuplicate(automation)}
                    onDelete={() => {
                      setSelectedAutomation(automation);
                      setShowDeleteDialog(true);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {inactiveAutomations.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Pause className="h-4 w-4" />
                Inactive ({inactiveAutomations.length})
              </h3>
              <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {inactiveAutomations.map((automation) => (
                  <AutomationCard
                    key={automation.id}
                    automation={automation}
                    onToggle={() => toggleAutomation(automation.id, !automation.is_active)}
                    onEdit={() => {
                      setSelectedAutomation(automation);
                      setShowStepsDialog(true);
                    }}
                    onDuplicate={() => handleDuplicate(automation)}
                    onDelete={() => {
                      setSelectedAutomation(automation);
                      setShowDeleteDialog(true);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Automation Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Automation</DialogTitle>
            <DialogDescription>
              Set up a new automation to run when specific events occur
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="automation-name">Name *</Label>
              <Input
                id="automation-name"
                value={newAutomation.name}
                onChange={(e) => setNewAutomation({ ...newAutomation, name: e.target.value })}
                placeholder="e.g., Send invoice reminder"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="automation-description">Description</Label>
              <Textarea
                id="automation-description"
                value={newAutomation.description}
                onChange={(e) => setNewAutomation({ ...newAutomation, description: e.target.value })}
                placeholder="What does this automation do?"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Trigger</Label>
                <Select
                  value={newAutomation.trigger_type}
                  onValueChange={(value) => 
                    setNewAutomation({ ...newAutomation, trigger_type: value as TriggerType })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TRIGGER_TYPE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        <div className="flex items-center gap-2">
                          {TRIGGER_ICONS[value as TriggerType]}
                          {label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Target Model</Label>
                <Select
                  value={newAutomation.target_model}
                  onValueChange={(value) => 
                    setNewAutomation({ ...newAutomation, target_model: value as EntityType })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ENTITY_TYPE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {FINANCIAL_MODELS.includes(newAutomation.target_model) && (
              <Alert className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
                <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <AlertDescription className="text-xs text-amber-800 dark:text-amber-200">
                  <span className="font-medium">Financial entity guardrail</span> — Automations on {ENTITY_TYPE_LABELS[newAutomation.target_model as EntityType]} must not modify totals, taxes, or GL-related fields. Use automations for notifications, tags, and informational updates only.
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setShowCreateDialog(false)} className="w-full sm:w-auto">
              Cancel
            </Button>
            <Button onClick={handleCreateAutomation} disabled={isSubmitting} className="w-full sm:w-auto">
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create & Configure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Steps Dialog */}
      {selectedAutomation && (
        <AutomationStepsDialog
          open={showStepsDialog}
          onOpenChange={setShowStepsDialog}
          automation={selectedAutomation}
        />
      )}

      {/* Template Gallery */}
      <AutomationTemplateGallery
        open={showTemplateGallery}
        onOpenChange={setShowTemplateGallery}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="max-w-[95vw] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Automation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedAutomation?.name}"? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel className="w-full sm:w-auto">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAutomation}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 w-full sm:w-auto"
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface AutomationCardProps {
  automation: AutomatedAction;
  onToggle: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function AutomationCard({ automation, onToggle, onEdit, onDuplicate, onDelete }: AutomationCardProps) {
  const isEventDriven = ["on_create", "on_update", "on_delete", "field_change"].includes(automation.trigger_type);
  const isTimeBased = automation.trigger_type === "time_based";
  const isConnected = isEventDriven || isTimeBased;

  const formatLastRun = (dateStr: string | null) => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  const isCircuitBroken = (automation as any).is_circuit_broken;

  return (
    <Card className={`${!automation.is_active ? "opacity-60" : ""} ${isCircuitBroken ? "border-destructive/50" : ""}`}>
      <CardHeader className="pb-2 p-3 sm:p-6 sm:pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`p-1.5 sm:p-2 rounded-md shrink-0 ${isCircuitBroken ? "bg-destructive/10 text-destructive" : automation.is_active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
              {isCircuitBroken ? <ShieldAlert className="h-4 w-4" /> : TRIGGER_ICONS[automation.trigger_type]}
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm sm:text-base truncate">{automation.name}</CardTitle>
              <CardDescription className="text-xs">
                {ENTITY_TYPE_LABELS[automation.target_model as EntityType] || automation.target_model}
              </CardDescription>
            </div>
          </div>
          <Switch checked={automation.is_active} onCheckedChange={onToggle} />
        </div>
      </CardHeader>
      <CardContent className="p-3 sm:p-6 pt-0 sm:pt-0">
        <div className="flex items-center gap-1 text-xs text-muted-foreground mb-2">
          <Badge variant="outline" className="text-xs">
            {TRIGGER_TYPE_LABELS[automation.trigger_type]}
          </Badge>
          <ArrowRight className="h-3 w-3" />
          <span>Actions</span>
        </div>

        {/* Circuit breaker warning */}
        {isCircuitBroken && (
          <div className="flex items-center gap-1.5 text-xs mb-2 p-1.5 rounded bg-destructive/10 text-destructive">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Circuit breaker tripped — auto-disabled due to excessive executions</span>
          </div>
        )}

        {/* Connection status indicator */}
        {!isCircuitBroken && (
          <div className="flex items-center gap-1.5 text-xs mb-2">
            {isConnected && automation.is_active ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />
                <span className="text-green-600 dark:text-green-400">
                  {isEventDriven ? "DB trigger active" : "Scheduled"}
                </span>
              </>
            ) : isConnected && !automation.is_active ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground inline-block" />
                <span className="text-muted-foreground">Inactive</span>
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 inline-block" />
                <span className="text-amber-600 dark:text-amber-400">Manual trigger only</span>
              </>
            )}
            {automation.last_run_at && (
              <span className="text-muted-foreground ml-auto flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatLastRun(automation.last_run_at)}
              </span>
            )}
          </div>
        )}

        {automation.description && (
          <p className="text-xs sm:text-sm text-muted-foreground mb-3 line-clamp-2">
            {automation.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit} className="h-8 text-xs sm:text-sm">
            <Pencil className="h-3 w-3 mr-1" />
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={onDuplicate} className="h-8 text-xs sm:text-sm">
            <Copy className="h-3 w-3 mr-1" />
            Copy
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} className="text-destructive h-8">
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface AutomationStepsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  automation: AutomatedAction;
}

function AutomationStepsDialog({ open, onOpenChange, automation }: AutomationStepsDialogProps) {
  const { steps, isLoading, addStep, deleteStep } = useAutomationSteps(automation.id);
  const [showAddStepDialog, setShowAddStepDialog] = useState(false);
  const [newStep, setNewStep] = useState({
    action_type: "send_email" as ActionType,
    step_name: "",
  });

  const handleAddStep = async () => {
    try {
      await addStep({
        action_id: automation.id,
        step_order: steps.length,
        step_name: newStep.step_name || null,
        action_type: newStep.action_type,
        action_config: {},
        condition: null,
        on_error: "continue",
      });
      setShowAddStepDialog(false);
      setNewStep({ action_type: "send_email", step_name: "" });
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to add step");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            {automation.name}
          </DialogTitle>
          <DialogDescription>
            Configure the steps that will run when this automation triggers
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Trigger Info */}
          <div className="p-3 border rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 text-sm font-medium">
              {TRIGGER_ICONS[automation.trigger_type]}
              When: {TRIGGER_TYPE_LABELS[automation.trigger_type]}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Target: {ENTITY_TYPE_LABELS[automation.target_model as EntityType] || automation.target_model}
            </p>
          </div>

          {/* Steps */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Action Steps</Label>
              <Button variant="outline" size="sm" onClick={() => setShowAddStepDialog(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Step
              </Button>
            </div>

            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : steps.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground border rounded-lg">
                <p className="text-sm">No steps configured</p>
                <p className="text-xs">Add steps to define what happens when this automation runs</p>
              </div>
            ) : (
              <div className="space-y-2">
                {steps.map((step, index) => (
                  <div key={step.id} className="flex items-center gap-2 p-3 border rounded-lg">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-medium shrink-0">
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {ACTION_ICONS[step.action_type]}
                        <span className="font-medium text-sm truncate">
                          {step.step_name || ACTION_TYPE_LABELS[step.action_type]}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {ACTION_TYPE_LABELS[step.action_type]}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => deleteStep(step.id)} className="shrink-0">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} className="w-full sm:w-auto">Done</Button>
        </DialogFooter>

        {/* Add Step Dialog */}
        <Dialog open={showAddStepDialog} onOpenChange={setShowAddStepDialog}>
          <DialogContent className="max-w-[95vw] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add Action Step</DialogTitle>
              <DialogDescription>
                Define what action to perform
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Action Type</Label>
                <Select
                  value={newStep.action_type}
                  onValueChange={(value) => setNewStep({ ...newStep, action_type: value as ActionType })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ACTION_TYPE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        <div className="flex items-center gap-2">
                          {ACTION_ICONS[value as ActionType]}
                          {label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Step Name (Optional)</Label>
                <Input
                  value={newStep.step_name}
                  onChange={(e) => setNewStep({ ...newStep, step_name: e.target.value })}
                  placeholder="e.g., Send welcome email"
                />
              </div>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setShowAddStepDialog(false)} className="w-full sm:w-auto">
                Cancel
              </Button>
              <Button onClick={handleAddStep} className="w-full sm:w-auto">
                Add Step
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

import { useState, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Plus,
  Trash2,
  GripVertical,
  ChevronDown,
  ChevronUp,
  Play,
  Mail,
  Bell,
  Webhook,
  FileEdit,
  Code,
  Calendar,
  User,
  AlertTriangle,
  CheckCircle,
  Loader2,
  ArrowDown,
  Settings,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AutomatedActionStep, ActionType, ACTION_TYPE_LABELS } from "@/hooks/useAutomations";

interface WorkflowNodeEditorProps {
  steps: AutomatedActionStep[];
  onAddStep: (step: Partial<AutomatedActionStep>) => Promise<void>;
  onUpdateStep: (id: string, updates: Partial<AutomatedActionStep>) => Promise<void>;
  onDeleteStep: (id: string) => Promise<void>;
  onReorderSteps: (steps: AutomatedActionStep[]) => Promise<void>;
  isLoading?: boolean;
}

const ACTION_ICONS: Record<ActionType, React.ReactNode> = {
  update_record: <FileEdit className="h-4 w-4" />,
  create_record: <Plus className="h-4 w-4" />,
  send_email: <Mail className="h-4 w-4" />,
  send_notification: <Bell className="h-4 w-4" />,
  webhook_call: <Webhook className="h-4 w-4" />,
  create_activity: <Calendar className="h-4 w-4" />,
  add_tag: <Plus className="h-4 w-4" />,
  run_code: <Code className="h-4 w-4" />,
};

const ACTION_COLORS: Record<ActionType, string> = {
  update_record: "border-blue-500/50 bg-blue-500/10",
  create_record: "border-green-500/50 bg-green-500/10",
  send_email: "border-purple-500/50 bg-purple-500/10",
  send_notification: "border-orange-500/50 bg-orange-500/10",
  webhook_call: "border-cyan-500/50 bg-cyan-500/10",
  create_activity: "border-yellow-500/50 bg-yellow-500/10",
  add_tag: "border-pink-500/50 bg-pink-500/10",
  run_code: "border-gray-500/50 bg-gray-500/10",
};

const ON_ERROR_OPTIONS = [
  { value: "continue", label: "Continue to next step", icon: <Play className="h-4 w-4" /> },
  { value: "stop", label: "Stop workflow", icon: <AlertTriangle className="h-4 w-4" /> },
  { value: "retry", label: "Retry step", icon: <Loader2 className="h-4 w-4" /> },
];

interface StepConfigPanelProps {
  step: AutomatedActionStep;
  onUpdate: (updates: Partial<AutomatedActionStep>) => void;
  onClose: () => void;
}

function StepConfigPanel({ step, onUpdate, onClose }: StepConfigPanelProps) {
  const [config, setConfig] = useState<Record<string, unknown>>(
    (step.action_config as Record<string, unknown>) || {}
  );

  const handleConfigChange = (key: string, value: unknown) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    onUpdate({ action_config: newConfig });
  };

  const renderConfigFields = () => {
    switch (step.action_type) {
      case "send_email":
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>To (Email)</Label>
              <Input
                value={(config.to as string) || ""}
                onChange={(e) => handleConfigChange("to", e.target.value)}
                placeholder="{{record.email}} or fixed email"
              />
              <p className="text-xs text-muted-foreground">
                Use {"{{record.field}}"} for dynamic values
              </p>
            </div>
            <div className="space-y-2">
              <Label>Subject</Label>
              <Input
                value={(config.subject as string) || ""}
                onChange={(e) => handleConfigChange("subject", e.target.value)}
                placeholder="Email subject with {{variables}}"
              />
            </div>
            <div className="space-y-2">
              <Label>Body</Label>
              <Textarea
                value={(config.body as string) || ""}
                onChange={(e) => handleConfigChange("body", e.target.value)}
                placeholder="Email body content..."
                rows={6}
              />
            </div>
            <div className="space-y-2">
              <Label>Template ID (optional)</Label>
              <Input
                value={(config.template_id as string) || ""}
                onChange={(e) => handleConfigChange("template_id", e.target.value)}
                placeholder="Use a saved email template"
              />
            </div>
          </div>
        );

      case "send_notification":
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={(config.title as string) || ""}
                onChange={(e) => handleConfigChange("title", e.target.value)}
                placeholder="Notification title"
              />
            </div>
            <div className="space-y-2">
              <Label>Message</Label>
              <Textarea
                value={(config.message as string) || ""}
                onChange={(e) => handleConfigChange("message", e.target.value)}
                placeholder="Notification message with {{variables}}"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select
                value={(config.priority as string) || "medium"}
                onValueChange={(v) => handleConfigChange("priority", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Notify User ID (optional)</Label>
              <Input
                value={(config.user_id as string) || ""}
                onChange={(e) => handleConfigChange("user_id", e.target.value)}
                placeholder="{{record.assigned_to}} or specific user ID"
              />
            </div>
          </div>
        );

      case "update_record":
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Target Table</Label>
              <Input
                value={(config.table as string) || ""}
                onChange={(e) => handleConfigChange("table", e.target.value)}
                placeholder="e.g., invoices, contacts"
              />
            </div>
            <div className="space-y-2">
              <Label>Record ID Field</Label>
              <Input
                value={(config.record_id_field as string) || "id"}
                onChange={(e) => handleConfigChange("record_id_field", e.target.value)}
                placeholder="Field containing the record ID"
              />
            </div>
            <div className="space-y-2">
              <Label>Values to Update (JSON)</Label>
              <Textarea
                value={
                  typeof config.values === "object"
                    ? JSON.stringify(config.values, null, 2)
                    : (config.values as string) || "{}"
                }
                onChange={(e) => {
                  try {
                    handleConfigChange("values", JSON.parse(e.target.value));
                  } catch {
                    // Keep as string if invalid JSON
                  }
                }}
                placeholder='{"status": "completed", "updated_at": "{{now}}"}'
                rows={5}
                className="font-mono text-sm"
              />
            </div>
          </div>
        );

      case "create_record":
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Target Table</Label>
              <Input
                value={(config.table as string) || ""}
                onChange={(e) => handleConfigChange("table", e.target.value)}
                placeholder="e.g., crm_activities, notifications"
              />
            </div>
            <div className="space-y-2">
              <Label>Record Data (JSON)</Label>
              <Textarea
                value={
                  typeof config.values === "object"
                    ? JSON.stringify(config.values, null, 2)
                    : (config.values as string) || "{}"
                }
                onChange={(e) => {
                  try {
                    handleConfigChange("values", JSON.parse(e.target.value));
                  } catch {
                    // Keep as string if invalid JSON
                  }
                }}
                placeholder='{"summary": "Follow up on {{record.name}}", "due_date": "{{now|date}}"}'
                rows={6}
                className="font-mono text-sm"
              />
            </div>
          </div>
        );

      case "webhook_call":
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Webhook URL</Label>
              <Input
                value={(config.url as string) || ""}
                onChange={(e) => handleConfigChange("url", e.target.value)}
                placeholder="https://api.example.com/webhook"
              />
            </div>
            <div className="space-y-2">
              <Label>HTTP Method</Label>
              <Select
                value={(config.method as string) || "POST"}
                onValueChange={(v) => handleConfigChange("method", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="PATCH">PATCH</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Headers (JSON)</Label>
              <Textarea
                value={
                  typeof config.headers === "object"
                    ? JSON.stringify(config.headers, null, 2)
                    : (config.headers as string) || "{}"
                }
                onChange={(e) => {
                  try {
                    handleConfigChange("headers", JSON.parse(e.target.value));
                  } catch {}
                }}
                placeholder={"'{\"Authorization\": \"Bearer ...\"}'"}
                rows={3}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label>Body (JSON)</Label>
              <Textarea
                value={
                  typeof config.body === "object"
                    ? JSON.stringify(config.body, null, 2)
                    : (config.body as string) || "{}"
                }
                onChange={(e) => {
                  try {
                    handleConfigChange("body", JSON.parse(e.target.value));
                  } catch {}
                }}
                placeholder='{"event": "invoice_created", "data": {{record|json}}}'
                rows={5}
                className="font-mono text-sm"
              />
            </div>
          </div>
        );

      case "create_activity":
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Activity Summary</Label>
              <Input
                value={(config.summary as string) || ""}
                onChange={(e) => handleConfigChange("summary", e.target.value)}
                placeholder="Follow up with {{record.contact_name}}"
              />
            </div>
            <div className="space-y-2">
              <Label>Activity Type</Label>
              <Select
                value={(config.activity_type as string) || "task"}
                onValueChange={(v) => handleConfigChange("activity_type", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="task">Task</SelectItem>
                  <SelectItem value="call">Call</SelectItem>
                  <SelectItem value="meeting">Meeting</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="followup">Follow-up</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Due Date</Label>
              <Input
                value={(config.due_date as string) || ""}
                onChange={(e) => handleConfigChange("due_date", e.target.value)}
                placeholder="{{now|date:yyyy-MM-dd}} or +3 days"
              />
            </div>
            <div className="space-y-2">
              <Label>Assign To (User ID)</Label>
              <Input
                value={(config.assigned_to as string) || ""}
                onChange={(e) => handleConfigChange("assigned_to", e.target.value)}
                placeholder="{{record.assigned_to}}"
              />
            </div>
          </div>
        );

      case "run_code":
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Edge Function Name</Label>
              <Input
                value={(config.function_name as string) || ""}
                onChange={(e) => handleConfigChange("function_name", e.target.value)}
                placeholder="my-custom-function"
              />
            </div>
            <div className="space-y-2">
              <Label>Function Payload (JSON)</Label>
              <Textarea
                value={
                  typeof config.payload === "object"
                    ? JSON.stringify(config.payload, null, 2)
                    : (config.payload as string) || "{}"
                }
                onChange={(e) => {
                  try {
                    handleConfigChange("payload", JSON.parse(e.target.value));
                  } catch {}
                }}
                placeholder='{"record_id": "{{record.id}}", "action": "process"}'
                rows={6}
                className="font-mono text-sm"
              />
            </div>
          </div>
        );

      default:
        return (
          <div className="text-center text-muted-foreground py-4">
            No configuration options for this action type.
          </div>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>Step Name</Label>
        <Input
          value={step.step_name || ""}
          onChange={(e) => onUpdate({ step_name: e.target.value })}
          placeholder="Descriptive name for this step"
        />
      </div>

      <div className="border-t pt-4">
        <h4 className="text-sm font-medium mb-4">Action Configuration</h4>
        {renderConfigFields()}
      </div>

      <div className="border-t pt-4 space-y-4">
        <h4 className="text-sm font-medium">Error Handling</h4>
        <div className="space-y-2">
          <Label>On Error</Label>
          <Select
            value={step.on_error || "continue"}
            onValueChange={(v) => onUpdate({ on_error: v as "continue" | "retry" | "stop" })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ON_ERROR_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex items-center gap-2">
                    {option.icon}
                    {option.label}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border-t pt-4 space-y-4">
        <h4 className="text-sm font-medium">Step Condition (Optional)</h4>
        <div className="space-y-2">
          <Label>Only run if (JSON condition)</Label>
          <Textarea
            value={
              step.condition
                ? JSON.stringify(step.condition, null, 2)
                : ""
            }
            onChange={(e) => {
              try {
                const cond = e.target.value ? JSON.parse(e.target.value) : null;
                onUpdate({ condition: cond });
              } catch {}
            }}
            placeholder='{"field": "status", "operator": "=", "value": "active"}'
            rows={4}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to always run this step
          </p>
        </div>
      </div>
    </div>
  );
}

export function WorkflowNodeEditor({
  steps,
  onAddStep,
  onUpdateStep,
  onDeleteStep,
  onReorderSteps,
  isLoading,
}: WorkflowNodeEditorProps) {
  const [selectedStep, setSelectedStep] = useState<AutomatedActionStep | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const sortedSteps = useMemo(
    () => [...steps].sort((a, b) => a.step_order - b.step_order),
    [steps]
  );

  const handleAddStep = async (actionType: ActionType) => {
    setIsAdding(true);
    try {
      await onAddStep({
        action_type: actionType,
        step_name: ACTION_TYPE_LABELS[actionType],
        step_order: sortedSteps.length + 1,
        action_config: {},
        on_error: "continue",
      });
      setShowAddMenu(false);
    } finally {
      setIsAdding(false);
    }
  };

  const handleMoveStep = async (stepId: string, direction: "up" | "down") => {
    const stepIndex = sortedSteps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) return;

    const newIndex = direction === "up" ? stepIndex - 1 : stepIndex + 1;
    if (newIndex < 0 || newIndex >= sortedSteps.length) return;

    const newSteps = [...sortedSteps];
    const [movedStep] = newSteps.splice(stepIndex, 1);
    newSteps.splice(newIndex, 0, movedStep);

    // Update step_order for all steps
    const reorderedSteps = newSteps.map((s, i) => ({
      ...s,
      step_order: i + 1,
    }));

    await onReorderSteps(reorderedSteps);
  };

  const handleUpdateStep = async (updates: Partial<AutomatedActionStep>) => {
    if (!selectedStep) return;
    await onUpdateStep(selectedStep.id, updates);
    setSelectedStep({ ...selectedStep, ...updates });
  };

  return (
    <div className="space-y-4">
      {/* Trigger Node (Start) */}
      <div className="flex flex-col items-center">
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/30">
          <Zap className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Trigger</span>
        </div>
        {sortedSteps.length > 0 && (
          <div className="w-px h-6 bg-border" />
        )}
      </div>

      {/* Step Nodes */}
      {sortedSteps.map((step, index) => (
        <div key={step.id} className="flex flex-col items-center">
          <Card
            className={cn(
              "w-full max-w-md cursor-pointer transition-all hover:shadow-md",
              ACTION_COLORS[step.action_type as ActionType] || "border-border",
              selectedStep?.id === step.id && "ring-2 ring-primary"
            )}
            onClick={() => setSelectedStep(step)}
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex flex-col items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleMoveStep(step.id, "up");
                    }}
                    disabled={index === 0}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleMoveStep(step.id, "down");
                    }}
                    disabled={index === sortedSteps.length - 1}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="p-1.5 rounded-md bg-background">
                      {ACTION_ICONS[step.action_type as ActionType]}
                    </div>
                    <span className="font-medium truncate">
                      {step.step_name || ACTION_TYPE_LABELS[step.action_type as ActionType]}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      Step {step.step_order}
                    </Badge>
                    {step.condition && (
                      <Badge variant="secondary" className="text-xs">
                        Conditional
                      </Badge>
                    )}
                    {step.on_error === "stop" && (
                      <Badge variant="destructive" className="text-xs">
                        Stop on error
                      </Badge>
                    )}
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteStep(step.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Connector Line */}
          <div className="w-px h-6 bg-border" />
          <ArrowDown className="h-4 w-4 text-muted-foreground -my-1" />
          <div className="w-px h-6 bg-border" />
        </div>
      ))}

      {/* Add Step Button */}
      <div className="flex flex-col items-center">
        {showAddMenu ? (
          <Card className="w-full max-w-md">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Add Action Step</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2">
              {Object.entries(ACTION_TYPE_LABELS).map(([type, label]) => (
                <Button
                  key={type}
                  variant="outline"
                  className="justify-start h-auto py-3"
                  onClick={() => handleAddStep(type as ActionType)}
                  disabled={isAdding}
                >
                  <div className="flex items-center gap-2">
                    {ACTION_ICONS[type as ActionType]}
                    <span className="text-xs">{label}</span>
                  </div>
                </Button>
              ))}
            </CardContent>
            <div className="px-4 pb-4">
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => setShowAddMenu(false)}
              >
                Cancel
              </Button>
            </div>
          </Card>
        ) : (
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => setShowAddMenu(true)}
            disabled={isLoading}
          >
            <Plus className="h-4 w-4" />
            Add Step
          </Button>
        )}
      </div>

      {/* End Node */}
      <div className="flex flex-col items-center">
        {sortedSteps.length > 0 && !showAddMenu && (
          <div className="w-px h-6 bg-border" />
        )}
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/30">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <span className="text-sm font-medium text-green-600">Complete</span>
        </div>
      </div>

      {/* Step Configuration Sheet */}
      <Sheet
        open={!!selectedStep}
        onOpenChange={(open) => !open && setSelectedStep(null)}
      >
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {selectedStep && ACTION_ICONS[selectedStep.action_type as ActionType]}
              Configure Step
            </SheetTitle>
            <SheetDescription>
              {selectedStep && ACTION_TYPE_LABELS[selectedStep.action_type as ActionType]}
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="h-[calc(100vh-120px)] mt-4 pr-4">
            {selectedStep && (
              <StepConfigPanel
                step={selectedStep}
                onUpdate={handleUpdateStep}
                onClose={() => setSelectedStep(null)}
              />
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}

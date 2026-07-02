import { useState } from "react";
import { useLeaveTypes, LeaveType } from "@/hooks/leave";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  MoreHorizontal,
  ArrowLeft,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { normalizeError } from "@/services/resilience";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

interface LeaveTypeSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface LeaveTypeFormData {
  name: string;
  code: string;
  color: string;
  description: string;
  requires_approval: boolean;
  requires_second_approval: boolean;
  second_approval_threshold_days: number | null;
  requires_document: boolean;
  is_paid: boolean;
  max_consecutive_days: number | null;
  min_notice_days: number;
  allow_half_day: boolean;
  accrual_enabled: boolean;
  accrual_rate: number;
  accrual_frequency: string;
  carryover_enabled: boolean;
  carryover_limit: number | null;
  negative_balance_allowed: boolean;
  negative_balance_limit: number | null;
}

const defaultFormData: LeaveTypeFormData = {
  name: "",
  code: "",
  color: "#3b82f6",
  description: "",
  requires_approval: true,
  requires_second_approval: false,
  second_approval_threshold_days: null,
  requires_document: false,
  is_paid: true,
  max_consecutive_days: null,
  min_notice_days: 1,
  allow_half_day: true,
  accrual_enabled: false,
  accrual_rate: 0,
  accrual_frequency: "monthly",
  carryover_enabled: false,
  carryover_limit: null,
  negative_balance_allowed: false,
  negative_balance_limit: null,
};

function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-start justify-between gap-3 rounded border p-3 cursor-pointer"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}

export function LeaveTypeSettingsDialog({
  open,
  onOpenChange,
}: LeaveTypeSettingsDialogProps) {
  const {
    leaveTypes,
    isLoading,
    createLeaveType,
    updateLeaveType,
    deleteLeaveType,
  } = useLeaveTypes();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editingType, setEditingType] = useState<LeaveType | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<LeaveTypeFormData>(defaultFormData);

  const resetForm = () => {
    setFormData(defaultFormData);
    setEditingType(null);
    setShowForm(false);
  };

  const handleEdit = (type: LeaveType) => {
    setEditingType(type);
    setFormData({
      name: type.name,
      code: type.code,
      color: type.color,
      description: type.description || "",
      requires_approval: type.requires_approval,
      requires_second_approval:
        (type as any).requires_second_approval ?? false,
      second_approval_threshold_days:
        (type as any).second_approval_threshold_days ?? null,
      requires_document: type.requires_document,
      is_paid: type.is_paid,
      max_consecutive_days: type.max_consecutive_days,
      min_notice_days: type.min_notice_days,
      allow_half_day: type.allow_half_day,
      accrual_enabled: type.accrual_enabled,
      accrual_rate: type.accrual_rate,
      accrual_frequency: type.accrual_frequency,
      carryover_enabled: type.carryover_enabled,
      carryover_limit: type.carryover_limit,
      negative_balance_allowed: type.negative_balance_allowed,
      negative_balance_limit: type.negative_balance_limit,
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.code.trim()) {
      toast({ title: "Name and code are required", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      if (editingType) {
        await updateLeaveType(editingType.id, formData);
      } else {
        await createLeaveType({
          ...formData,
          is_active: true,
          carryover_deadline: null,
        });
      }
      resetForm();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (type: LeaveType) => {
    if (!confirm(`Delete leave type "${type.name}"?`)) return;
    try {
      await deleteLeaveType(type.id);
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const title = showForm
    ? editingType
      ? `Edit "${editingType.name}"`
      : "New leave type"
    : "Leave type settings";

  const description = showForm
    ? "Configure eligibility, approval, and accrual for this leave type."
    : "Configure the leave types available for your organization.";

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) resetForm();
      }}
      title={title}
      description={description}
      size="xl"
      onSubmit={showForm ? handleSubmit : undefined}
      headerRight={
        showForm ? (
          <Button variant="ghost" size="sm" onClick={resetForm}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        ) : (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add leave type
          </Button>
        )
      }
      footer={
        showForm ? (
          <>
            <Button type="button" variant="outline" onClick={resetForm}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {editingType ? "Save changes" : "Create leave type"}
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        )
      }
    >
      {!showForm ? (
        isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : leaveTypes.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No leave types configured. Click "Add leave type" to create one.
          </div>
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Leave type</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Approval</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaveTypes.map((type) => (
                  <TableRow key={type.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: type.color }}
                        />
                        <span className="font-medium">{type.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{type.code}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={type.is_paid ? "default" : "secondary"}>
                        {type.is_paid ? "Paid" : "Unpaid"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {type.requires_approval ? "Required" : "Auto"}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEdit(type)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDelete(type)}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : (
        <>
          <WorkflowSheetGrid>
            <WorkflowSheetSection number={1} title="Identity">
              <WorkflowField label="Name" htmlFor="name" required>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  placeholder="e.g. Annual Leave"
                />
              </WorkflowField>
              <WorkflowSheetGrid>
                <WorkflowField label="Code" htmlFor="code" required>
                  <Input
                    id="code"
                    value={formData.code}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        code: e.target.value.toUpperCase(),
                      })
                    }
                    placeholder="AL"
                  />
                </WorkflowField>
                <WorkflowField label="Color" htmlFor="color">
                  <div className="flex gap-2">
                    <Input
                      id="color"
                      type="color"
                      value={formData.color}
                      onChange={(e) =>
                        setFormData({ ...formData, color: e.target.value })
                      }
                      className="w-12 h-10 p-1 shrink-0"
                    />
                    <Input
                      value={formData.color}
                      onChange={(e) =>
                        setFormData({ ...formData, color: e.target.value })
                      }
                      className="flex-1 min-w-0"
                    />
                  </div>
                </WorkflowField>
              </WorkflowSheetGrid>
              <WorkflowField label="Description" htmlFor="description">
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  rows={2}
                />
              </WorkflowField>
              <ToggleRow
                id="is_paid"
                label="Paid leave"
                description="Counted toward salary as worked time."
                checked={formData.is_paid}
                onCheckedChange={(v) =>
                  setFormData({ ...formData, is_paid: v })
                }
              />
            </WorkflowSheetSection>

            <WorkflowSheetSection number={2} title="Eligibility & limits">
              <WorkflowSheetGrid>
                <WorkflowField label="Min notice (days)" htmlFor="min_notice">
                  <Input
                    id="min_notice"
                    type="number"
                    min="0"
                    value={formData.min_notice_days}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        min_notice_days: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                </WorkflowField>
                <WorkflowField
                  label="Max consecutive days"
                  htmlFor="max_consecutive"
                >
                  <Input
                    id="max_consecutive"
                    type="number"
                    min="0"
                    value={formData.max_consecutive_days || ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        max_consecutive_days: e.target.value
                          ? parseInt(e.target.value)
                          : null,
                      })
                    }
                    placeholder="No limit"
                  />
                </WorkflowField>
              </WorkflowSheetGrid>
              <ToggleRow
                id="allow_half_day"
                label="Allow half days"
                checked={formData.allow_half_day}
                onCheckedChange={(v) =>
                  setFormData({ ...formData, allow_half_day: v })
                }
              />
              <ToggleRow
                id="requires_document"
                label="Requires supporting document"
                description="Employees must attach a file (e.g. medical certificate)."
                checked={formData.requires_document}
                onCheckedChange={(v) =>
                  setFormData({ ...formData, requires_document: v })
                }
              />
              <ToggleRow
                id="negative_balance"
                label="Allow negative balance"
                description="Permit requests that exceed the available balance."
                checked={formData.negative_balance_allowed}
                onCheckedChange={(v) =>
                  setFormData({ ...formData, negative_balance_allowed: v })
                }
              />
            </WorkflowSheetSection>

            <WorkflowSheetSection number={3} title="Approval flow">
              <ToggleRow
                id="requires_approval"
                label="Requires approval"
                description="Submissions wait for a manager decision."
                checked={formData.requires_approval}
                onCheckedChange={(v) =>
                  setFormData({ ...formData, requires_approval: v })
                }
              />
              <ToggleRow
                id="requires_second_approval"
                label="Requires second-level approval"
                description="Two managers must sign off before approval is final."
                checked={formData.requires_second_approval}
                disabled={!formData.requires_approval}
                onCheckedChange={(v) =>
                  setFormData({ ...formData, requires_second_approval: v })
                }
              />
              {formData.requires_second_approval && (
                <WorkflowField
                  label="Second-approval threshold (days)"
                  htmlFor="second_approval_threshold_days"
                  hint="Only requests of this many days or more require final approval. Leave blank to apply to every request."
                >
                  <Input
                    id="second_approval_threshold_days"
                    type="number"
                    min={0}
                    step="0.5"
                    placeholder="Apply to all requests"
                    value={formData.second_approval_threshold_days ?? ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        second_approval_threshold_days:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </WorkflowField>
              )}
            </WorkflowSheetSection>

            <WorkflowSheetSection number={4} title="Accrual">
              <ToggleRow
                id="accrual_enabled"
                label="Enable accrual"
                description="Automatically grant days on a recurring schedule."
                checked={formData.accrual_enabled}
                onCheckedChange={(v) =>
                  setFormData({ ...formData, accrual_enabled: v })
                }
              />
              {formData.accrual_enabled && (
                <>
                  <WorkflowSheetGrid>
                    <WorkflowField
                      label="Accrual rate (days)"
                      htmlFor="accrual_rate"
                    >
                      <Input
                        id="accrual_rate"
                        type="number"
                        step="0.5"
                        min="0"
                        value={formData.accrual_rate}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            accrual_rate: parseFloat(e.target.value) || 0,
                          })
                        }
                      />
                    </WorkflowField>
                    <WorkflowField label="Frequency" htmlFor="accrual_frequency">
                      <Select
                        value={formData.accrual_frequency}
                        onValueChange={(v) =>
                          setFormData({ ...formData, accrual_frequency: v })
                        }
                      >
                        <SelectTrigger id="accrual_frequency">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="monthly">Monthly</SelectItem>
                          <SelectItem value="quarterly">Quarterly</SelectItem>
                          <SelectItem value="annually">Annually</SelectItem>
                        </SelectContent>
                      </Select>
                    </WorkflowField>
                  </WorkflowSheetGrid>
                  <ToggleRow
                    id="carryover_enabled"
                    label="Enable carryover"
                    description="Roll unused balance into the next period."
                    checked={formData.carryover_enabled}
                    onCheckedChange={(v) =>
                      setFormData({ ...formData, carryover_enabled: v })
                    }
                  />
                  {formData.carryover_enabled && (
                    <WorkflowField
                      label="Carryover limit (days)"
                      htmlFor="carryover_limit"
                    >
                      <Input
                        id="carryover_limit"
                        type="number"
                        min="0"
                        value={formData.carryover_limit || ""}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            carryover_limit: e.target.value
                              ? parseInt(e.target.value)
                              : null,
                          })
                        }
                        placeholder="No limit"
                      />
                    </WorkflowField>
                  )}
                </>
              )}
            </WorkflowSheetSection>
          </WorkflowSheetGrid>
        </>
      )}
    </WorkflowSheet>
  );
}

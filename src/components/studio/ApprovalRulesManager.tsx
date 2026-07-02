/**
 * Studio Approval Rules Manager
 * 
 * Allows configuring approval workflows on entity state-change actions.
 * Example: Require manager approval before confirming POs above $5,000.
 */

import { useState } from "react";
import { useApprovalRules, ApprovalRule } from "@/hooks/useApprovalRules";
import { ENTITY_TYPE_LABELS, EntityType } from "@/hooks/useEntityFields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Plus,
  ShieldCheck,
  Trash2,
  Pencil,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";

const ENTITY_ACTIONS: Record<string, { value: string; label: string }[]> = {
  invoice: [
    { value: "confirm", label: "Confirm Invoice" },
    { value: "void", label: "Void Invoice" },
    { value: "send", label: "Send Invoice" },
  ],
  estimate: [
    { value: "confirm", label: "Confirm Estimate" },
    { value: "convert_to_invoice", label: "Convert to Invoice" },
  ],
  sales_order: [
    { value: "confirm", label: "Confirm Sales Order" },
    { value: "cancel", label: "Cancel Sales Order" },
  ],
  purchase_order: [
    { value: "confirm", label: "Confirm Purchase Order" },
    { value: "cancel", label: "Cancel PO" },
  ],
  bill: [
    { value: "confirm", label: "Confirm Bill" },
    { value: "void", label: "Void Bill" },
  ],
  expense: [
    { value: "approve", label: "Approve Expense" },
    { value: "reject", label: "Reject Expense" },
  ],
  stock_adjustment: [
    { value: "apply", label: "Apply Stock Adjustment" },
  ],
};

const THRESHOLD_OPERATORS = [
  { value: ">", label: "Greater than" },
  { value: ">=", label: "Greater than or equal" },
  { value: "<", label: "Less than" },
  { value: "<=", label: "Less than or equal" },
  { value: "=", label: "Equal to" },
];

export function ApprovalRulesManager() {
  const { rules, isLoading, createRule, updateRule, deleteRule, toggleRule } = useApprovalRules();
  const [showDialog, setShowDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<ApprovalRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApprovalRule | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    entity_type: "invoice" as string,
    action_name: "",
    description: "",
    approver_type: "specific_user",
    approver_role: "",
    approval_mode: "any",
    threshold_field: "",
    threshold_operator: ">",
    threshold_value: "",
    use_threshold: false,
  });

  const resetForm = () => {
    setFormData({
      entity_type: "invoice",
      action_name: "",
      description: "",
      approver_type: "specific_user",
      approver_role: "",
      approval_mode: "any",
      threshold_field: "",
      threshold_operator: ">",
      threshold_value: "",
      use_threshold: false,
    });
    setEditingRule(null);
  };

  const openCreate = () => {
    resetForm();
    setShowDialog(true);
  };

  const openEdit = (rule: ApprovalRule) => {
    setEditingRule(rule);
    setFormData({
      entity_type: rule.entity_type,
      action_name: rule.action_name,
      description: rule.description || "",
      approver_type: rule.approver_type,
      approver_role: rule.approver_role || "",
      approval_mode: rule.approval_mode,
      threshold_field: rule.threshold_field || "",
      threshold_operator: rule.threshold_operator || ">",
      threshold_value: rule.threshold_value?.toString() || "",
      use_threshold: !!rule.threshold_field,
    });
    setShowDialog(true);
  };

  const handleSave = async () => {
    if (!formData.entity_type || !formData.action_name) {
      toast.error("Entity type and action are required");
      return;
    }

    setIsSaving(true);
    try {
      const payload: Partial<ApprovalRule> = {
        entity_type: formData.entity_type,
        action_name: formData.action_name,
        description: formData.description || null,
        approver_type: formData.approver_type,
        approver_role: formData.approver_role || null,
        approval_mode: formData.approval_mode,
        threshold_field: formData.use_threshold ? formData.threshold_field || null : null,
        threshold_operator: formData.use_threshold ? formData.threshold_operator : null,
        threshold_value: formData.use_threshold && formData.threshold_value
          ? parseFloat(formData.threshold_value)
          : null,
      };

      if (editingRule) {
        await updateRule(editingRule.id, payload);
      } else {
        await createRule(payload);
      }
      setShowDialog(false);
      resetForm();
    } catch {
      toast.error("Failed to save approval rule");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteRule(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      toast.error("Failed to delete rule");
    }
  };

  const actions = ENTITY_ACTIONS[formData.entity_type] || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Approval Rules
          </h2>
          <p className="text-sm text-muted-foreground">
            Require approval before critical actions can be performed
          </p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Add Rule
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : rules.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ShieldCheck className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No approval rules</h3>
            <p className="text-muted-foreground mb-4">
              Set up rules to require approval before confirming orders, invoices, or other actions.
            </p>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Create First Rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <Card key={rule.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={rule.is_active}
                      onCheckedChange={() => toggleRule(rule.id)}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">
                          {ENTITY_TYPE_LABELS[rule.entity_type as EntityType] || rule.entity_type}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          {rule.action_name}
                        </Badge>
                        {rule.is_active ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>
                      {rule.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{rule.description}</p>
                      )}
                      {rule.threshold_field && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          When {rule.threshold_field} {rule.threshold_operator} {rule.threshold_value}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(rule)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(rule)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRule ? "Edit Approval Rule" : "Create Approval Rule"}</DialogTitle>
            <DialogDescription>
              Define when approval is required before an action can be completed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Entity Type</Label>
                <Select value={formData.entity_type} onValueChange={v => setFormData(p => ({ ...p, entity_type: v, action_name: "" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(ENTITY_ACTIONS).map(([key]) => (
                      <SelectItem key={key} value={key}>
                        {ENTITY_TYPE_LABELS[key as EntityType] || key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Action</Label>
                <Select value={formData.action_name} onValueChange={v => setFormData(p => ({ ...p, action_name: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select action" /></SelectTrigger>
                  <SelectContent>
                    {actions.map(a => (
                      <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>Description (optional)</Label>
              <Textarea
                value={formData.description}
                onChange={e => setFormData(p => ({ ...p, description: e.target.value }))}
                placeholder="e.g., Require approval for POs above $5,000"
                className="h-16"
              />
            </div>

            <div>
              <Label>Approver Type</Label>
              <Select value={formData.approver_type} onValueChange={v => setFormData(p => ({ ...p, approver_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="specific_user">Specific User</SelectItem>
                  <SelectItem value="role">By Role</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {formData.approver_type === "role" && (
              <div>
                <Label>Approver Role</Label>
                <Input
                  value={formData.approver_role}
                  onChange={e => setFormData(p => ({ ...p, approver_role: e.target.value }))}
                  placeholder="e.g., admin, manager"
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <Switch
                checked={formData.use_threshold}
                onCheckedChange={v => setFormData(p => ({ ...p, use_threshold: v }))}
              />
              <Label>Apply threshold condition</Label>
            </div>

            {formData.use_threshold && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-xs">Field</Label>
                  <Input
                    value={formData.threshold_field}
                    onChange={e => setFormData(p => ({ ...p, threshold_field: e.target.value }))}
                    placeholder="total_amount"
                  />
                </div>
                <div>
                  <Label className="text-xs">Operator</Label>
                  <Select value={formData.threshold_operator} onValueChange={v => setFormData(p => ({ ...p, threshold_operator: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {THRESHOLD_OPERATORS.map(op => (
                        <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Value</Label>
                  <Input
                    type="number"
                    value={formData.threshold_value}
                    onChange={e => setFormData(p => ({ ...p, threshold_value: e.target.value }))}
                    placeholder="5000"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {editingRule ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Approval Rule</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove this approval rule. Actions that were previously gated will proceed without approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

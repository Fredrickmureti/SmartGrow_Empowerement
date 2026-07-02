import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, GitBranch, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Condition,
  ConditionGroup,
  SimpleCondition,
  ComparisonOperator,
  LogicalOperator,
} from "@/lib/automation/conditionEvaluator";

interface ConditionBuilderProps {
  value: Condition | null;
  onChange: (condition: Condition | null) => void;
  availableFields?: Array<{ name: string; label: string; type?: string }>;
  compact?: boolean;
}

const OPERATORS: Array<{
  value: ComparisonOperator;
  label: string;
  requiresValue: boolean;
}> = [
  { value: "=", label: "equals", requiresValue: true },
  { value: "!=", label: "not equals", requiresValue: true },
  { value: ">", label: "greater than", requiresValue: true },
  { value: "<", label: "less than", requiresValue: true },
  { value: ">=", label: "greater or equal", requiresValue: true },
  { value: "<=", label: "less or equal", requiresValue: true },
  { value: "contains", label: "contains", requiresValue: true },
  { value: "not_contains", label: "does not contain", requiresValue: true },
  { value: "starts_with", label: "starts with", requiresValue: true },
  { value: "ends_with", label: "ends with", requiresValue: true },
  { value: "in", label: "is one of", requiresValue: true },
  { value: "not_in", label: "is not one of", requiresValue: true },
  { value: "is_set", label: "is set", requiresValue: false },
  { value: "is_not_set", label: "is not set", requiresValue: false },
  { value: "changed", label: "has changed", requiresValue: false },
  { value: "changed_to", label: "changed to", requiresValue: true },
  { value: "changed_from", label: "changed from", requiresValue: true },
];

const DEFAULT_FIELDS = [
  { name: "status", label: "Status", type: "string" },
  { name: "email", label: "Email", type: "string" },
  { name: "name", label: "Name", type: "string" },
  { name: "amount", label: "Amount", type: "number" },
  { name: "total", label: "Total", type: "number" },
  { name: "created_at", label: "Created At", type: "date" },
  { name: "updated_at", label: "Updated At", type: "date" },
  { name: "is_active", label: "Is Active", type: "boolean" },
  { name: "assigned_to", label: "Assigned To", type: "string" },
  { name: "priority", label: "Priority", type: "string" },
];

function isConditionGroup(condition: Condition): condition is ConditionGroup {
  return "logic" in condition && "conditions" in condition;
}

interface SimpleConditionEditorProps {
  condition: SimpleCondition;
  onChange: (condition: SimpleCondition) => void;
  onRemove: () => void;
  fields: Array<{ name: string; label: string; type?: string }>;
  compact?: boolean;
}

function SimpleConditionEditor({
  condition,
  onChange,
  onRemove,
  fields,
  compact,
}: SimpleConditionEditorProps) {
  const operatorConfig = OPERATORS.find((o) => o.value === condition.operator);
  const requiresValue = operatorConfig?.requiresValue ?? true;

  return (
    <div
      className={cn(
        "flex items-center gap-2 p-2 rounded-md bg-muted/50",
        compact ? "flex-wrap" : ""
      )}
    >
      <Select
        value={condition.field}
        onValueChange={(field) => onChange({ ...condition, field })}
      >
        <SelectTrigger className={cn("w-[140px]", compact && "w-[120px]")}>
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {fields.map((field) => (
            <SelectItem key={field.name} value={field.name}>
              {field.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={condition.operator}
        onValueChange={(operator) =>
          onChange({ ...condition, operator: operator as ComparisonOperator })
        }
      >
        <SelectTrigger className={cn("w-[140px]", compact && "w-[110px]")}>
          <SelectValue placeholder="Operator" />
        </SelectTrigger>
        <SelectContent>
          {OPERATORS.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {requiresValue && (
        <Input
          value={
            Array.isArray(condition.value)
              ? condition.value.join(", ")
              : String(condition.value ?? "")
          }
          onChange={(e) => {
            let value: unknown = e.target.value;
            // Handle comma-separated values for "in" operators
            if (
              condition.operator === "in" ||
              condition.operator === "not_in"
            ) {
              value = e.target.value.split(",").map((v) => v.trim());
            }
            onChange({ ...condition, value });
          }}
          placeholder={
            condition.operator === "in" || condition.operator === "not_in"
              ? "value1, value2, ..."
              : "Value"
          }
          className={cn("flex-1 min-w-[100px]", compact && "min-w-[80px]")}
        />
      )}

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={onRemove}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

interface ConditionGroupEditorProps {
  group: ConditionGroup;
  onChange: (group: ConditionGroup) => void;
  onRemove?: () => void;
  fields: Array<{ name: string; label: string; type?: string }>;
  depth?: number;
  compact?: boolean;
}

function ConditionGroupEditor({
  group,
  onChange,
  onRemove,
  fields,
  depth = 0,
  compact,
}: ConditionGroupEditorProps) {
  const handleAddCondition = () => {
    onChange({
      ...group,
      conditions: [
        ...group.conditions,
        { field: fields[0]?.name || "status", operator: "=", value: "" },
      ],
    });
  };

  const handleAddGroup = () => {
    onChange({
      ...group,
      conditions: [
        ...group.conditions,
        {
          logic: group.logic === "and" ? "or" : "and",
          conditions: [
            { field: fields[0]?.name || "status", operator: "=", value: "" },
          ],
        },
      ],
    });
  };

  const handleRemoveCondition = (index: number) => {
    const newConditions = group.conditions.filter((_, i) => i !== index);
    onChange({ ...group, conditions: newConditions });
  };

  const handleUpdateCondition = (index: number, condition: Condition) => {
    const newConditions = [...group.conditions];
    newConditions[index] = condition;
    onChange({ ...group, conditions: newConditions });
  };

  const toggleLogic = () => {
    onChange({
      ...group,
      logic: group.logic === "and" ? "or" : "and",
    });
  };

  return (
    <Card
      className={cn(
        "border-l-4",
        group.logic === "and" ? "border-l-blue-500" : "border-l-orange-500",
        depth > 0 && "ml-4"
      )}
    >
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={toggleLogic}
            className={cn(
              "text-xs font-medium",
              group.logic === "and"
                ? "border-blue-500 text-blue-600"
                : "border-orange-500 text-orange-600"
            )}
          >
            {group.logic === "and" ? "ALL" : "ANY"} conditions must match
          </Button>
          {onRemove && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onRemove}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="space-y-2">
          {group.conditions.map((condition, index) => (
            <div key={index}>
              {index > 0 && (
                <div className="flex items-center justify-center py-1">
                  <Badge
                    variant="secondary"
                    className={cn(
                      "text-xs",
                      group.logic === "and"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-orange-100 text-orange-700"
                    )}
                  >
                    {group.logic.toUpperCase()}
                  </Badge>
                </div>
              )}
              {isConditionGroup(condition) ? (
                <ConditionGroupEditor
                  group={condition}
                  onChange={(g) => handleUpdateCondition(index, g)}
                  onRemove={() => handleRemoveCondition(index)}
                  fields={fields}
                  depth={depth + 1}
                  compact={compact}
                />
              ) : (
                <SimpleConditionEditor
                  condition={condition}
                  onChange={(c) => handleUpdateCondition(index, c)}
                  onRemove={() => handleRemoveCondition(index)}
                  fields={fields}
                  compact={compact}
                />
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleAddCondition}
            className="text-xs"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add condition
          </Button>
          {depth < 2 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddGroup}
              className="text-xs"
            >
              <GitBranch className="h-3 w-3 mr-1" />
              Add group
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function ConditionBuilder({
  value,
  onChange,
  availableFields,
  compact,
}: ConditionBuilderProps) {
  const fields = availableFields || DEFAULT_FIELDS;

  // Initialize with a group if value is a simple condition or null
  const normalizedValue: ConditionGroup | null = value
    ? isConditionGroup(value)
      ? value
      : { logic: "and", conditions: [value] }
    : null;

  const handleChange = (group: ConditionGroup | null) => {
    if (!group || group.conditions.length === 0) {
      onChange(null);
    } else if (group.conditions.length === 1 && !isConditionGroup(group.conditions[0])) {
      // Simplify to single condition if only one exists
      onChange(group.conditions[0]);
    } else {
      onChange(group);
    }
  };

  if (!normalizedValue) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Conditions</Label>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            handleChange({
              logic: "and",
              conditions: [
                { field: fields[0]?.name || "status", operator: "=", value: "" },
              ],
            })
          }
          className="w-full"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add condition
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Conditions</Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleChange(null)}
          className="text-xs text-muted-foreground"
        >
          Clear all
        </Button>
      </div>
      <ConditionGroupEditor
        group={normalizedValue}
        onChange={handleChange}
        fields={fields}
        compact={compact}
      />
    </div>
  );
}

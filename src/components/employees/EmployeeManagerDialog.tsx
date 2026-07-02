// @ts-nocheck
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useEmployees } from "@/hooks/useEmployees";
import { toast } from "sonner";
import { Users, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { normalizeError } from "@/services/resilience";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

interface EmployeeManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  employeeName: string;
  currentManagerId: string | null;
  onSuccess: () => void;
}

export function EmployeeManagerDialog({
  open,
  onOpenChange,
  employeeId,
  employeeName,
  currentManagerId,
  onSuccess,
}: EmployeeManagerDialogProps) {
  const { employees } = useEmployees();
  const [selectedManagerId, setSelectedManagerId] = useState<string>(currentManagerId || "none");
  const [isLoading, setIsLoading] = useState(false);

  const availableManagers = employees.filter(
    (e) => e.id !== employeeId && e.is_active,
  );
  const currentManager = employees.find((e) => e.id === currentManagerId);

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const { error } = await supabase
        .from("employees")
        .update({ manager_id: selectedManagerId === "none" ? null : selectedManagerId })
        .eq("id", employeeId);
      if (error) throw error;
      toast.success("Manager updated successfully");
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error updating manager:", error);
      toast.error(normalizeError(error).message || "Failed to update manager");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          Set manager — {employeeName}
        </span>
      }
      description="The manager can approve this employee's leave requests and timesheets."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isLoading || selectedManagerId === (currentManagerId || "none")}
          >
            <UserPlus className="h-4 w-4 mr-2" />
            {isLoading ? "Saving..." : "Save manager"}
          </Button>
        </>
      }
    >
      {currentManager && (
        <WorkflowSheetSection
          number={1}
          title="Current manager"
          subtitle="The reporting line in effect right now."
        >
          <div className="rounded-lg border bg-muted/50 p-3 flex items-center gap-3">
            <Avatar className="h-8 w-8">
              <AvatarFallback>
                {currentManager.first_name[0]}{currentManager.last_name[0]}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {currentManager.first_name} {currentManager.last_name}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {currentManager.position || "—"}
              </p>
            </div>
            <Badge variant="secondary">Current</Badge>
          </div>
        </WorkflowSheetSection>
      )}

      <WorkflowSheetSection
        number={currentManager ? 2 : 1}
        title="New manager"
        subtitle="Pick from active employees. Choose “No manager” to clear the reporting line."
      >
        <WorkflowField label="Manager" required>
          <Select value={selectedManagerId} onValueChange={setSelectedManagerId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a manager" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                <span className="text-muted-foreground">No Manager</span>
              </SelectItem>
              {availableManagers.map((emp) => (
                <SelectItem key={emp.id} value={emp.id}>
                  <div className="flex items-center gap-2">
                    <span>{emp.first_name} {emp.last_name}</span>
                    {emp.position && (
                      <span className="text-xs text-muted-foreground">({emp.position})</span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

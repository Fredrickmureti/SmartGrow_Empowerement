/**
 * DepartmentRecordForm — shared create/edit form for Departments, mounted
 * on `RecordFormShell`. Replaces the legacy narrow inline `<Dialog>` from
 * `src/pages/Departments.tsx` and aligns the Employees app with the same
 * routed record pattern used by Finance accounts, Contacts, and every
 * other substantive business record in the ERP.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDepartments,
  type Department,
  type DepartmentFormData,
} from "@/hooks/useDepartments";
import { useEmployees } from "@/hooks/useEmployees";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface DepartmentRecordFormProps {
  mode: "create" | "edit";
  department?: Department | null;
}

export function DepartmentRecordForm({ mode, department }: DepartmentRecordFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { activeDepartments, createDepartment, updateDepartment } = useDepartments();
  const { activeEmployees } = useEmployees();

  const [formData, setFormData] = useState<DepartmentFormData>({
    name: department?.name ?? "",
    code: department?.code ?? "",
    description: department?.description ?? "",
    manager_id: department?.manager_id ?? null,
    parent_department_id: department?.parent_department_id ?? null,
    is_active: department?.is_active ?? true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formData.name?.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      if (mode === "edit" && department) {
        await updateDepartment(department.id, formData);
        toast({ title: "Department updated successfully" });
      } else {
        await createDepartment(formData);
        toast({ title: "Department created successfully" });
      }
      navigate("/hr/employees/departments");
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

  return (
    <RecordFormShell
      mode={mode}
      entityLabel="Department"
      recordRef={department?.code ?? undefined}
      meta={
        mode === "edit"
          ? department?.name
          : "Add a new department to your organization."
      }
      cancelHref="/hr/employees/departments"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={mode === "edit" ? "Save changes" : "Create Department"}
    >
      <Section title="Identity" description="How this department appears in directories and org charts.">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g. Human Resources"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="code">Code</Label>
            <Input
              id="code"
              value={formData.code ?? ""}
              onChange={(e) => setFormData({ ...formData, code: e.target.value })}
              placeholder="e.g. HR"
            />
          </div>
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description ?? ""}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description of the department"
                rows={3}
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section title="Org placement" description="Where this department sits in your structure and who runs it.">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="manager">Department manager</Label>
            <Select
              value={formData.manager_id ?? "none"}
              onValueChange={(value) =>
                setFormData({ ...formData, manager_id: value === "none" ? null : value })
              }
            >
              <SelectTrigger id="manager"><SelectValue placeholder="Select manager" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No manager</SelectItem>
                {activeEmployees.map((emp) => (
                  <SelectItem key={emp.id} value={emp.id}>
                    {emp.first_name} {emp.last_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="parent">Parent department</Label>
            <Select
              value={formData.parent_department_id ?? "none"}
              onValueChange={(value) =>
                setFormData({
                  ...formData,
                  parent_department_id: value === "none" ? null : value,
                })
              }
            >
              <SelectTrigger id="parent"><SelectValue placeholder="Select parent" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No parent (top level)</SelectItem>
                {activeDepartments
                  .filter((d) => d.id !== department?.id)
                  .map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </FieldGrid>
      </Section>
    </RecordFormShell>
  );
}

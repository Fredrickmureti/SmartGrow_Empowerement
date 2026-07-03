/**
 * JobPositionRecordForm — shared create/edit form for Job Positions,
 * mounted on `RecordFormShell`. Replaces the legacy `WorkflowSheet`
 * side drawer in `src/pages/hr/JobPositions.tsx`.
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
import { useJobPositions, type JobPosition } from "@/hooks/useJobPositions";
import { useDepartments } from "@/hooks/useDepartments";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface JobPositionRecordFormProps {
  mode: "create" | "edit";
  position?: JobPosition | null;
}

export function JobPositionRecordForm({ mode, position }: JobPositionRecordFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { create, update } = useJobPositions();
  const { activeDepartments } = useDepartments();

  const [formData, setFormData] = useState({
    name: position?.name ?? "",
    code: position?.code ?? "",
    department_id: position?.department_id ?? "",
    description: position?.description ?? "",
    target_headcount: position?.target_headcount?.toString() ?? "",
    is_active: position?.is_active ?? true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = {
        name: formData.name.trim(),
        code: formData.code.trim() || null,
        department_id: formData.department_id || null,
        description: formData.description.trim() || null,
        target_headcount: formData.target_headcount
          ? parseInt(formData.target_headcount, 10)
          : null,
        is_active: formData.is_active,
      };
      if (mode === "edit" && position) {
        await update(position.id, payload as any);
      } else {
        await create(payload as any);
      }
      navigate("/hr/employees/positions");
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
      entityLabel="Job Position"
      recordRef={position?.code ?? undefined}
      meta={
        mode === "edit"
          ? position?.name
          : "Reusable role catalog. Drives employee org placement, headcount planning and recruitment."
      }
      cancelHref="/hr/employees/positions"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={mode === "edit" ? "Save changes" : "Create Position"}
    >
      <Section title="Identity" description="How the role appears in directories, org charts and recruitment.">
        <FieldGrid columns={2}>
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. Senior Accountant"
                required
              />
            </div>
          </FieldCell>
          <div className="space-y-2">
            <Label htmlFor="code">Code</Label>
            <Input
              id="code"
              value={formData.code}
              onChange={(e) => setFormData({ ...formData, code: e.target.value })}
              placeholder="e.g. SR-ACCT"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="target_headcount">Target headcount</Label>
            <Input
              id="target_headcount"
              type="number"
              min={0}
              value={formData.target_headcount}
              onChange={(e) =>
                setFormData({ ...formData, target_headcount: e.target.value })
              }
              placeholder="Used for capacity planning"
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Org placement" description="Where this role sits in your structure.">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="department">Department</Label>
            <Select
              value={formData.department_id || "none"}
              onValueChange={(v) =>
                setFormData({ ...formData, department_id: v === "none" ? "" : v })
              }
            >
              <SelectTrigger id="department"><SelectValue placeholder="No department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No department</SelectItem>
                {activeDepartments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Description" description="Optional summary shown on the position profile.">
        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            rows={4}
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
        </div>
      </Section>
    </RecordFormShell>
  );
}

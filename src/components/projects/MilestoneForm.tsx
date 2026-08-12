/**
 * MilestoneForm — create/edit a project milestone.
 *
 * Honours project pricing model: when the project is `pricing_type='milestone'`
 * billing_amount becomes required so the post-completion trigger can write a
 * project_revenue_entry.
 *
 * Pass 6 — Projects: migrated from `Dialog` to `WorkflowSheet`.
 */
import { useEffect, useState } from "react";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import type { Project, ProjectMilestone } from "@/hooks/projects";

interface MilestoneFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  milestone?: ProjectMilestone | null;
  onSaved: () => void | Promise<void>;
}

export function MilestoneForm({
  open,
  onOpenChange,
  project,
  milestone,
  onSaved,
}: MilestoneFormProps) {
  const { currentOrg } = useOrganization();
  const isEdit = !!milestone;
  const requiresAmount = project.pricing_type === "milestone";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState<Date | undefined>();
  const [billingAmount, setBillingAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(milestone?.name || "");
      setDescription(milestone?.description || "");
      setDeadline(milestone?.deadline ? new Date(milestone.deadline) : undefined);
      setBillingAmount(
        ((milestone as unknown as { billing_amount?: number | null })?.billing_amount?.toString()) || ""
      );
    }
  }, [open, milestone]);

  const validate = (): string | null => {
    if (!name.trim()) return "Milestone name is required.";
    if (requiresAmount && !billingAmount) {
      return "This project bills by milestone — set a billing amount.";
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    if (!currentOrg) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        deadline: deadline ? format(deadline, "yyyy-MM-dd") : null,
        billing_amount: billingAmount ? parseFloat(billingAmount) : null,
      };
      if (isEdit && milestone) {
        const { error } = await supabase
          .from("project_milestones")
          .update(payload as never)
          .eq("id", milestone.id);
        if (error) throw error;
        toast.success("Milestone updated");
      } else {
        const { error } = await supabase.from("project_milestones").insert({
          ...payload,
          project_id: project.id,
          organization_id: currentOrg.id,
          is_reached: false,
          sequence: 0,
        } as never);
        if (error) throw error;
        toast.success("Milestone created");
      }
      await onSaved();
      onOpenChange(false);
    } catch (e) {
      console.error(e);
      toast.error("Failed to save milestone");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={isEdit ? "Edit milestone" : "New milestone"}
      description={
        requiresAmount
          ? "Milestones track major project progress. This project bills by milestone — the billing amount is invoiced when the milestone is reached."
          : "Milestones track major project progress."
      }
      onSubmit={handleSubmit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Create milestone"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Milestone">
        <WorkflowField label="Name" htmlFor="ms-name" required>
          <Input
            id="ms-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Design sign-off"
            required
            autoFocus
          />
        </WorkflowField>
        <WorkflowSheetGrid>
          <WorkflowField label="Deadline">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !deadline && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {deadline ? format(deadline, "MMM d, yyyy") : "Pick date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={deadline} onSelect={setDeadline} initialFocus />
              </PopoverContent>
            </Popover>
          </WorkflowField>
          <WorkflowField
            label={`Billing amount${requiresAmount ? "" : ""}`}
            htmlFor="ms-amount"
            required={requiresAmount}
            hint={`${project.currency ? `${project.currency} — ` : ""}invoiced on completion if billed by milestone.`}
          >
            <Input
              id="ms-amount"
              type="number"
              step="0.01"
              value={billingAmount}
              onChange={(e) => setBillingAmount(e.target.value)}
              placeholder="0.00"
            />
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Deliverable">
        <WorkflowField label="Description" htmlFor="ms-desc">
          <Textarea
            id="ms-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="What needs to be delivered for this milestone to be marked as reached?"
          />
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

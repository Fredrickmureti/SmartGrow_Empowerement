import { useState, useEffect } from "react";
import { WorkflowSheet, WorkflowSheetSection } from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, XCircle, Plus } from "lucide-react";
import { useCRMLostReasons } from "@/hooks/crm/useCRMLostReasons";
import { Input } from "@/components/ui/input";

interface MarkAsLostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadName: string;
  onConfirm: (reasonId: string | undefined, notes: string | undefined) => Promise<void>;
}

export function MarkAsLostDialog({
  open,
  onOpenChange,
  leadName,
  onConfirm,
}: MarkAsLostDialogProps) {
  const { lostReasons, isLoading: reasonsLoading, initializeDefaultReasons, createLostReason } = useCRMLostReasons();
  const [selectedReasonId, setSelectedReasonId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAddReason, setShowAddReason] = useState(false);
  const [newReasonName, setNewReasonName] = useState("");

  useEffect(() => {
    if (!reasonsLoading && lostReasons.length === 0 && open) {
      initializeDefaultReasons();
    }
  }, [reasonsLoading, lostReasons.length, open]);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm(selectedReasonId || undefined, notes || undefined);
      setSelectedReasonId("");
      setNotes("");
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to mark as lost:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddReason = async () => {
    if (!newReasonName.trim()) return;
    try {
      const newReason = await createLostReason(newReasonName.trim());
      setSelectedReasonId(newReason.id);
      setNewReasonName("");
      setShowAddReason(false);
    } catch (error) {
      console.error("Failed to add reason:", error);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <XCircle className="h-5 w-5 text-destructive" />
          Mark Lead as Lost
        </span>
      }
      description={`Why was "${leadName}" lost? This helps improve your sales process.`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Mark as Lost
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Reason">
        {reasonsLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <RadioGroup
            value={selectedReasonId}
            onValueChange={setSelectedReasonId}
            className="grid gap-2"
          >
            {lostReasons.map((reason) => (
              <div
                key={reason.id}
                className="flex items-center space-x-2 rounded-md border p-3 hover:bg-muted/50 cursor-pointer"
                onClick={() => setSelectedReasonId(reason.id)}
              >
                <RadioGroupItem value={reason.id} id={reason.id} />
                <Label htmlFor={reason.id} className="flex-1 cursor-pointer">
                  {reason.name}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}

        {showAddReason ? (
          <div className="flex gap-2">
            <Input
              placeholder="Enter new reason..."
              value={newReasonName}
              onChange={(e) => setNewReasonName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddReason()}
            />
            <Button size="sm" onClick={handleAddReason}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAddReason(false)}>Cancel</Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setShowAddReason(true)}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add custom reason
          </Button>
        )}
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Notes" subtitle="Optional additional context">
        <Textarea
          id="notes"
          placeholder="Any additional context about why this lead was lost..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

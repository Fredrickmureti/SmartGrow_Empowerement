/**
 * Bulk dialog for assigning a department or work location to many
 * employees in one shot. Reused by the directory's BulkActionBar.
 *
 * Migrated to the WorkflowSheet design standard.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

interface Option { id: string; name: string }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  options: Option[];
  count: number;
  onApply: (value: string | null) => Promise<void>;
}

export function BulkAssignDialog({ open, onOpenChange, title, label, options, count, onApply }: Props) {
  const [value, setValue] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onApply(value === "__none__" ? null : value || null);
      onOpenChange(false);
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={title}
      description={`Update ${count} selected employee${count === 1 ? "" : "s"} in one operation.`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!value || busy}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Apply
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title={label} subtitle="Choose a value or clear the current assignment.">
        <WorkflowField label={label} required>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger><SelectValue placeholder={`Select ${label.toLowerCase()}`} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— Clear —</SelectItem>
              {options.map((o) => (
                <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

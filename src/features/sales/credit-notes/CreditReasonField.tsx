/**
 * CreditReasonField — the single reason control shared by every surface that
 * raises a customer credit.
 *
 * The reason is descriptive metadata for the audit trail, not a workflow
 * switch: nothing in the accounting path branches on it. It is required, it
 * comes from an industry-neutral list, and the free-text detail is always
 * available and always appended, so "Other" is never a dead end.
 */
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CREDIT_REASON_OPTIONS, CREDIT_REASON_OTHER } from "./creditReasonOptions";

interface Props {
  /** The chosen catalog value, or CREDIT_REASON_OTHER. */
  choice: string;
  onChoiceChange: (value: string) => void;
  /** The free-text reason actually persisted. */
  reason: string;
  onReasonChange: (value: string) => void;
  notes: string;
  onNotesChange: (value: string) => void;
}

export function CreditReasonField({
  choice,
  onChoiceChange,
  reason,
  onReasonChange,
  notes,
  onNotesChange,
}: Props) {
  return (
    <>
      <div className="space-y-2">
        <Label>Reason for Credit *</Label>
        <Select
          value={choice}
          onValueChange={(v) => {
            onChoiceChange(v);
            onReasonChange(v === CREDIT_REASON_OTHER ? "" : v);
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose a reason" />
          </SelectTrigger>
          <SelectContent>
            {CREDIT_REASON_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {choice === CREDIT_REASON_OTHER && (
          <Input
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Describe the reason"
          />
        )}
      </div>
      <div className="space-y-2">
        <Label>Detail / internal note</Label>
        <Textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Anything an auditor should know about this credit"
          rows={3}
        />
      </div>
    </>
  );
}

/**
 * ReversalReasonField — the single operator control for "why is this being
 * reversed?" (ADR 0129, Phase 5.2).
 *
 * Every reversal sheet renders this instead of a bare textarea, so the reason
 * vocabulary is identical across sales, purchases and receiving and matches
 * exactly what `assert_reversal_reason` accepts server-side.
 */
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useReversalReasonCodes,
  type ReversalDocumentType,
  type ReversalReasonCode,
} from "./useReversalReasonCodes";

interface ReversalReasonFieldProps {
  documentType: ReversalDocumentType;
  idPrefix: string;
  code: string;
  comment: string;
  onCodeChange: (code: string) => void;
  onCommentChange: (comment: string) => void;
  disabled?: boolean;
  /** Reason codes, hoisted so the parent can gate its confirm button. */
  reasonCodes?: ReversalReasonCode[];
  isLoading?: boolean;
}

export function ReversalReasonField({
  documentType,
  idPrefix,
  code,
  comment,
  onCodeChange,
  onCommentChange,
  disabled,
  reasonCodes: hoisted,
  isLoading: hoistedLoading,
}: ReversalReasonFieldProps) {
  const fallback = useReversalReasonCodes(documentType, hoisted === undefined);
  const reasonCodes = hoisted ?? fallback.reasonCodes;
  const isLoading = hoistedLoading ?? fallback.isLoading;

  const selected = reasonCodes.find((r) => r.code === code);
  const commentRequired = Boolean(selected?.requires_comment);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-reason-code`}>
          Reason <span className="text-destructive">*</span>
        </Label>
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <Select value={code} onValueChange={onCodeChange} disabled={disabled}>
            <SelectTrigger id={`${idPrefix}-reason-code`}>
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {reasonCodes.map((reason) => (
                <SelectItem key={reason.code} value={reason.code}>
                  {reason.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {selected?.description && (
          <p className="text-xs text-muted-foreground">{selected.description}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-reason-comment`}>
          Explanation{" "}
          {commentRequired ? (
            <span className="text-destructive">*</span>
          ) : (
            <span className="text-muted-foreground text-xs">(optional)</span>
          )}
        </Label>
        <Textarea
          id={`${idPrefix}-reason-comment`}
          value={comment}
          onChange={(event) => onCommentChange(event.target.value)}
          placeholder={
            commentRequired
              ? "This reason requires a written explanation for the audit trail"
              : "Add context for whoever reviews this later"
          }
          rows={3}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface VoidReason {
  id: string;
  code: string;
  label: string;
  requires_note: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactionNumber?: string;
  isSubmitting?: boolean;
  onConfirm: (input: { voidReasonId: string; voidNote?: string }) => void;
}

export function VoidTransactionDialog({
  open,
  onOpenChange,
  transactionNumber,
  isSubmitting,
  onConfirm,
}: Props) {
  const [reasonId, setReasonId] = useState<string>("");
  const [note, setNote] = useState<string>("");

  const { data: reasons = [] } = useQuery({
    queryKey: ["pos-void-reasons"],
    queryFn: async (): Promise<VoidReason[]> => {
      const { data, error } = await supabase
        .from("pos_void_reasons")
        .select("id, code, label, requires_note")
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return (data || []) as VoidReason[];
    },
    enabled: open,
  });

  useEffect(() => {
    if (!open) {
      setReasonId("");
      setNote("");
    }
  }, [open]);

  const selected = reasons.find((r) => r.id === reasonId);
  const noteRequired = !!selected?.requires_note;
  const canSubmit =
    !!reasonId && (!noteRequired || note.trim().length > 0) && !isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Void transaction</DialogTitle>
          <DialogDescription>
            {transactionNumber
              ? `Voiding ${transactionNumber}. Stock and cash will be reversed within the open shift.`
              : "Stock and cash will be reversed within the open shift."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Reason</Label>
            <Select value={reasonId} onValueChange={setReasonId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a reason…" />
              </SelectTrigger>
              <SelectContent>
                {reasons.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                    {r.requires_note ? " *" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>
              Note {noteRequired ? <span className="text-destructive">*</span> : null}
            </Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={noteRequired ? "Required for this reason" : "Optional"}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canSubmit}
            onClick={() =>
              onConfirm({
                voidReasonId: reasonId,
                voidNote: note.trim() || undefined,
              })
            }
          >
            {isSubmitting ? "Voiding…" : "Void transaction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

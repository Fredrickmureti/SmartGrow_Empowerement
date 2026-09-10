/**
 * Void an approved / paid expense.
 *
 * A reason code from the shared `reversal_reason_codes` vocabulary is
 * mandatory (ADR 0129) — the server refuses the void without one.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

interface ReasonCode {
  code: string;
  label: string;
  requires_comment: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expenseDescription?: string;
  onConfirm: (reason: string, reasonCode: string) => Promise<void>;
}

export function VoidExpenseDialog({
  open,
  onOpenChange,
  expenseDescription,
  onConfirm,
}: Props) {
  const [code, setCode] = useState<string>("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: codes = [] } = useQuery({
    queryKey: ["reversal-reason-codes", "expense"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reversal_reason_codes" as any)
        .select("code,label,requires_comment,applies_to,active,sort_order")
        .eq("active", true)
        .contains("applies_to", ["expense"])
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as unknown as ReasonCode[];
    },
    enabled: open,
  });

  useEffect(() => {
    if (!open) {
      setCode("");
      setComment("");
    }
  }, [open]);

  const selected = codes.find((c) => c.code === code);
  const needsComment = !!selected?.requires_comment;
  const valid = !!code && (!needsComment || comment.trim().length > 0);

  const confirm = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await onConfirm(comment.trim() || `Void of expense: ${expenseDescription ?? ""}`, code);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void expense</DialogTitle>
          <DialogDescription>
            The original ledger entry is reversed and kept in the reversal
            register. Nothing is deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Reason</Label>
            <Select value={code} onValueChange={setCode}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a reason" />
              </SelectTrigger>
              <SelectContent>
                {codes.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="void-comment">
              Comment{needsComment ? "" : " (optional)"}
            </Label>
            <Textarea
              id="void-comment"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={!valid || busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Void expense
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

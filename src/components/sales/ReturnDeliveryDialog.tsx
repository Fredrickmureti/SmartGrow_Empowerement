import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { RotateCcw, Loader2 } from "lucide-react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { FieldGroup } from "@/design-system/primitives/FieldGrid";

export interface ReturnableLine {
  product_id: string | null;
  label: string;
  quantity_delivered: number;
}

interface ReturnDeliveryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deliveryNoteId: string;
  deliveryNumber: string;
  lines: ReturnableLine[];
  onReturned?: () => void;
}

interface LineState {
  selected: boolean;
  quantity: number;
}

export function ReturnDeliveryDialog({
  open,
  onOpenChange,
  deliveryNoteId,
  deliveryNumber,
  lines,
  onReturned,
}: ReturnDeliveryDialogProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<Record<string, LineState>>({});

  const returnable = useMemo(
    () => lines.filter((l) => l.product_id && l.quantity_delivered > 0),
    [lines],
  );

  useEffect(() => {
    if (open) {
      const init: Record<string, LineState> = {};
      for (const l of returnable) {
        init[l.product_id!] = { selected: false, quantity: l.quantity_delivered };
      }
      setState(init);
      setReason("");
    }
  }, [open, returnable]);

  const update = (productId: string, patch: Partial<LineState>) =>
    setState((prev) => ({ ...prev, [productId]: { ...prev[productId], ...patch } }));

  const selectedLines = returnable.filter((l) => state[l.product_id!]?.selected);
  const canSubmit =
    selectedLines.length > 0 &&
    selectedLines.every((l) => {
      const q = state[l.product_id!]?.quantity ?? 0;
      return q > 0 && q <= l.quantity_delivered;
    });

  const handleSubmit = async () => {
    if (!canSubmit || !user) return;
    setSubmitting(true);
    try {
      const payload = selectedLines.map((l) => ({
        product_id: l.product_id,
        quantity: state[l.product_id!].quantity,
      }));
      const { data, error } = await supabase.rpc("create_return_delivery_atomic" as any, {
        p_original_dn_id: deliveryNoteId,
        p_user_id: user.id,
        p_lines: payload as any,
        p_reason: reason || null,
        p_post_immediately: true,
      });
      if (error) throw error;
      const res = data as { success?: boolean; return_delivery_number?: string };
      toast({ title: "Return delivery created", description: `${res?.return_delivery_number || "Return"} posted — stock and COGS reversed.` });
      onReturned?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Return failed", description: e?.message || "Could not create the return delivery.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <RotateCcw className="h-5 w-5" />
          Create return delivery
        </span>
      }
      description={`Return goods from delivery ${deliveryNumber}. This reverses inventory movements and cost-of-goods accounting for the selected items.`}
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          }
          trailing={
            <Button onClick={handleSubmit} disabled={!canSubmit || submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Post return
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">
        {returnable.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">This delivery has no stockable lines to return.</p>
        ) : (
          <FieldGroup label="Select Items to Return">
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-10" />
                    <TableHead>Item</TableHead>
                    <TableHead className="text-center">Delivered</TableHead>
                    <TableHead className="text-center w-28">Return qty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {returnable.map((l) => {
                    const s = state[l.product_id!] ?? { selected: false, quantity: 0 };
                    return (
                      <TableRow key={l.product_id}>
                        <TableCell>
                          <Checkbox checked={s.selected} onCheckedChange={(v) => update(l.product_id!, { selected: !!v })} />
                        </TableCell>
                        <TableCell className="font-medium">{l.label}</TableCell>
                        <TableCell className="text-center">{l.quantity_delivered}</TableCell>
                        <TableCell className="text-center">
                          <Input
                            type="number"
                            min={1}
                            max={l.quantity_delivered}
                            step="any"
                            value={s.quantity}
                            disabled={!s.selected}
                            onChange={(e) => update(l.product_id!, { quantity: Number(e.target.value) })}
                            className="h-8 text-center"
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </FieldGroup>
        )}

        <FieldGroup label="Reason">
          <div className="space-y-1.5">
            <Label htmlFor="return-reason">Reason (optional)</Label>
            <Textarea
              id="return-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Damaged in transit, wrong item delivered"
              rows={2}
            />
          </div>
        </FieldGroup>
      </div>
    </DetailSheet>
  );
}

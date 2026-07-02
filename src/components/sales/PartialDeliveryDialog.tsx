import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useRecordPartialDelivery } from "@/hooks/useDeliveryLifecycle";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { FieldGroup } from "@/design-system/primitives/FieldGrid";

export interface PartialItem {
  id: string;
  name: string;
  quantity_ordered: number;
  quantity_delivered: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deliveryNoteId: string;
  items: PartialItem[];
  onDone?: () => void;
}

export function PartialDeliveryDialog({ open, onOpenChange, deliveryNoteId, items, onDone }: Props) {
  const record = useRecordPartialDelivery(deliveryNoteId);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [createBackorder, setCreateBackorder] = useState(true);
  const [receivedBy, setReceivedBy] = useState("");

  useEffect(() => {
    if (open) {
      const initial: Record<string, number> = {};
      items.forEach((i) => { initial[i.id] = i.quantity_delivered || i.quantity_ordered; });
      setQtys(initial);
      setReceivedBy("");
      setCreateBackorder(true);
    }
  }, [open, items]);

  const hasRemainder = useMemo(
    () => items.some((i) => (qtys[i.id] ?? 0) < i.quantity_ordered),
    [items, qtys],
  );

  const handleSubmit = async () => {
    await record.mutateAsync({
      id: deliveryNoteId,
      line_qtys: items.map((i) => ({
        item_id: i.id,
        quantity_delivered: Math.max(0, Math.min(qtys[i.id] ?? 0, i.quantity_ordered)),
      })),
      create_backorder: createBackorder && hasRemainder,
      received_by: receivedBy || undefined,
      pod: receivedBy ? { received_by_name: receivedBy } : null,
    });
    onOpenChange(false);
    onDone?.();
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Record partial delivery"
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          }
          trailing={
            <Button onClick={handleSubmit} disabled={record.isPending}>
              {record.isPending ? "Saving…" : "Complete + release stock"}
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">
        <FieldGroup label="Line Items">
          <div className="rounded border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-center w-24">Ordered</TableHead>
                  <TableHead className="text-center w-32">Delivering</TableHead>
                  <TableHead className="text-center w-24">Remainder</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => {
                  const q = qtys[i.id] ?? 0;
                  const rem = Math.max(0, i.quantity_ordered - q);
                  return (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.name}</TableCell>
                      <TableCell className="text-center">{i.quantity_ordered}</TableCell>
                      <TableCell className="text-center">
                        <Input
                          type="number"
                          min={0}
                          max={i.quantity_ordered}
                          value={q}
                          className="h-8 text-center"
                          onChange={(e) => setQtys({ ...qtys, [i.id]: Number(e.target.value) || 0 })}
                        />
                      </TableCell>
                      <TableCell className="text-center text-muted-foreground">{rem}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </FieldGroup>

        <FieldGroup label="Proof of Delivery">
          <div className="space-y-2">
            <Label className="text-xs">Received by</Label>
            <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Recipient name" />
          </div>
          {hasRemainder && (
            <label className="flex items-center gap-2 text-sm mt-2">
              <Checkbox checked={createBackorder} onCheckedChange={(c) => setCreateBackorder(!!c)} />
              Create backorder delivery for remaining items
            </label>
          )}
        </FieldGroup>
      </div>
    </DetailSheet>
  );
}

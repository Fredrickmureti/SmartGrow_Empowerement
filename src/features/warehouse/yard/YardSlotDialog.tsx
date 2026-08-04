/**
 * YardSlotDialog — create/edit a yard parking position.
 * Slots are master data (ordinary CRUD); only *occupancy* is RPC-owned.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSaveYardSlot } from "./useYard";
import { SLOT_TYPE_LABEL, YARD_ZONE_LABEL, YARD_ZONE_ORDER, type YardSlotRow } from "./yardModel";
import { printYardSlotLabel } from "./yardLabels";
import { useOrganization } from "@/hooks/useOrganization";
import { Printer } from "lucide-react";
import { toast } from "sonner";

export function YardSlotDialog({
  open,
  onOpenChange,
  warehouseId,
  slot,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  warehouseId: string;
  slot: YardSlotRow | null;
}) {
  const [code, setCode] = useState("");
  const [slotType, setSlotType] = useState("either");
  const [zoneKind, setZoneKind] = useState("parking_bay");
  const [sequence, setSequence] = useState("");
  const save = useSaveYardSlot();
  const [printing, setPrinting] = useState(false);
  const { currentOrg } = useOrganization();

  async function printLabel(target: YardSlotRow) {
    if (!currentOrg?.id) {
      toast.error("No active organization");
      return;
    }
    setPrinting(true);
    try {
      const res = await printYardSlotLabel({ orgId: currentOrg.id, slot: target });
      if (res.success) toast.success("Slot label sent to the printer");
      else toast.error(res.error ?? "Could not print the slot label");
    } finally {
      setPrinting(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setCode(slot?.code ?? "");
    setSlotType(slot?.slot_type ?? "either");
    setZoneKind(slot?.zone_kind ?? "parking_bay");
    setSequence(slot?.sequence != null ? String(slot.sequence) : "");
  }, [open, slot]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{slot ? `Edit slot ${slot.code}` : "New yard slot"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Slot code *</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="P-12" />
          </div>
          <div className="min-w-0 grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Zone</Label>
              <Select value={zoneKind} onValueChange={setZoneKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {YARD_ZONE_ORDER.map((z) => (
                    <SelectItem key={z} value={z}>
                      {YARD_ZONE_LABEL[z]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Slot type</Label>
              <Select value={slotType} onValueChange={setSlotType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SLOT_TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Sequence (drives allocation order)</Label>
            <Input
              type="number"
              value={sequence}
              onChange={(e) => setSequence(e.target.value)}
              placeholder="10"
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {slot ? (
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={printing}
              onClick={() => void printLabel(slot)}
            >
              <Printer className="h-4 w-4" /> Print slot label
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button

            disabled={!code.trim() || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: slot?.id,
                  warehouseId,
                  code,
                  slotType,
                  zoneKind,
                  sequence: sequence === "" ? null : Number(sequence),
                },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Save
          </Button>
          </div>
        </DialogFooter>

      </DialogContent>
    </Dialog>
  );
}

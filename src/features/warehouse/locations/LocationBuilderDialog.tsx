/**
 * LocationBuilderDialog — quick structure build from the workspace.
 *
 * The full authoring surface is the Layout Designer route; this dialog is
 * the in-context shortcut. Both share `LocationRunBuilder`, so there is one
 * authoring implementation, not two.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LocationRunBuilder } from "./LocationRunBuilder";
import type { LocationNode } from "./types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  warehouseId: string | null;
  parent: LocationNode | null;
}

export function LocationBuilderDialog({ open, onOpenChange, warehouseId, parent }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>
            {parent ? `Build inside ${parent.code}` : "Build the warehouse structure"}
          </DialogTitle>
          <DialogDescription>
            Describe the run once; the system creates every position, its label code and its walk
            order.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <LocationRunBuilder
            warehouseId={warehouseId}
            parent={parent}
            compact
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

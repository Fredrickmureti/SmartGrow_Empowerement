/**
 * Table Session Dialog
 * 
 * Dialog for opening a table, setting guest count, and adding notes.
 */

import { useState } from "react";
import { POSTable } from "@/hooks/pos/useFloorPlan";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Users, Minus, Plus, Loader2 } from "lucide-react";

interface TableSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  table: POSTable | null;
  onConfirm: (guestsCount: number, notes?: string) => void;
  isLoading?: boolean;
}

export function TableSessionDialog({
  open,
  onOpenChange,
  table,
  onConfirm,
  isLoading,
}: TableSessionDialogProps) {
  const [guestsCount, setGuestsCount] = useState(2);
  const [notes, setNotes] = useState("");

  const handleConfirm = () => {
    onConfirm(guestsCount, notes || undefined);
    // Reset for next use
    setGuestsCount(2);
    setNotes("");
  };

  const handleClose = () => {
    onOpenChange(false);
    setGuestsCount(2);
    setNotes("");
  };

  if (!table) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open Table {table.table_number}</DialogTitle>
          <DialogDescription>
            Set the number of guests to begin the order.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Guest Count */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Number of Guests
            </Label>
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setGuestsCount(Math.max(1, guestsCount - 1))}
                disabled={guestsCount <= 1}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="text-4xl font-bold w-16 text-center">{guestsCount}</span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setGuestsCount(Math.min(table.seats * 2, guestsCount + 1))}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-center text-sm text-muted-foreground">
              Table capacity: {table.seats} seats
            </p>
          </div>

          {/* Quick Guest Buttons */}
          <div className="flex justify-center gap-2">
            {[1, 2, 3, 4, 5, 6].map(num => (
              <Button
                key={num}
                variant={guestsCount === num ? "default" : "outline"}
                size="sm"
                onClick={() => setGuestsCount(num)}
                className="w-10 h-10"
              >
                {num}
              </Button>
            ))}
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              placeholder="Special requests, allergies, occasion..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isLoading}>
            {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Open Table
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

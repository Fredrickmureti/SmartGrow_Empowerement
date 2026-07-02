/**
 * Table Transfer Dialog Component
 * 
 * UI for merging tables or transferring items between sessions.
 */

import { useState } from "react";
import { useTableTransfer } from "@/hooks/pos/useTableTransfer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { ArrowRightLeft, Merge, Move, AlertTriangle } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";

interface TableTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceSession: {
    id: string;
    tableName: string;
    items?: Array<{
      id: string;
      name: string;
      quantity: number;
      total: number;
    }>;
  };
  availableSessions: Array<{
    id: string;
    tableName: string;
    tableNumber: string;
  }>;
  availableTables?: Array<{
    id: string;
    name: string;
    number: string;
  }>;
  onComplete?: () => void;
}

export function TableTransferDialog({
  open,
  onOpenChange,
  sourceSession,
  availableSessions,
  availableTables = [],
  onComplete,
}: TableTransferDialogProps) {
  const { mergeTables, transferItems, moveSession } = useTableTransfer();
  const { formatCurrency } = useCurrency();
  
  const [mode, setMode] = useState<"merge" | "transfer" | "move">("merge");
  const [targetSessionId, setTargetSessionId] = useState<string>("");
  const [targetTableId, setTargetTableId] = useState<string>("");
  const [selectedItems, setSelectedItems] = useState<Map<string, number>>(new Map());
  const [notes, setNotes] = useState("");

  const handleMerge = async () => {
    if (!targetSessionId) return;
    
    await mergeTables.mutateAsync({
      sourceSessionId: sourceSession.id,
      targetSessionId,
      notes: notes || undefined,
    });
    
    onComplete?.();
    onOpenChange(false);
  };

  const handleTransfer = async () => {
    if (!targetSessionId || selectedItems.size === 0) return;
    
    const itemsToTransfer = Array.from(selectedItems.entries()).map(([id, qty]) => ({
      transactionItemId: id,
      quantity: qty,
    }));
    
    await transferItems.mutateAsync({
      sourceSessionId: sourceSession.id,
      targetSessionId,
      itemsToTransfer,
      notes: notes || undefined,
    });
    
    onComplete?.();
    onOpenChange(false);
  };

  const handleMove = async () => {
    if (!targetTableId) return;
    
    await moveSession.mutateAsync({
      sessionId: sourceSession.id,
      newTableId: targetTableId,
      notes: notes || undefined,
    });
    
    onComplete?.();
    onOpenChange(false);
  };

  const toggleItem = (itemId: string, quantity: number) => {
    const newSelected = new Map(selectedItems);
    if (newSelected.has(itemId)) {
      newSelected.delete(itemId);
    } else {
      newSelected.set(itemId, quantity);
    }
    setSelectedItems(newSelected);
  };

  const isLoading = mergeTables.isPending || transferItems.isPending || moveSession.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            Transfer / Merge - {sourceSession.tableName}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="merge">
              <Merge className="h-4 w-4 mr-2" />
              Merge
            </TabsTrigger>
            <TabsTrigger value="transfer">
              <ArrowRightLeft className="h-4 w-4 mr-2" />
              Transfer Items
            </TabsTrigger>
            <TabsTrigger value="move">
              <Move className="h-4 w-4 mr-2" />
              Move Table
            </TabsTrigger>
          </TabsList>

          <TabsContent value="merge" className="space-y-4 mt-4">
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <div className="flex gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-amber-700 dark:text-amber-400">
                    Merge Tables
                  </p>
                  <p className="text-muted-foreground">
                    All items from {sourceSession.tableName} will be moved to the selected table.
                    The source table will be closed.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Merge into:</Label>
              <div className="grid grid-cols-2 gap-2">
                {availableSessions
                  .filter(s => s.id !== sourceSession.id)
                  .map((session) => (
                    <div
                      key={session.id}
                      onClick={() => setTargetSessionId(session.id)}
                      className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                        targetSessionId === session.id
                          ? "border-primary bg-primary/10"
                          : "hover:bg-accent"
                      }`}
                    >
                      <div className="font-medium">{session.tableName}</div>
                      <div className="text-sm text-muted-foreground">#{session.tableNumber}</div>
                    </div>
                  ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Reason for merge..."
                rows={2}
              />
            </div>

            <Button
              className="w-full"
              onClick={handleMerge}
              disabled={!targetSessionId || isLoading}
            >
              <Merge className="h-4 w-4 mr-2" />
              Merge Tables
            </Button>
          </TabsContent>

          <TabsContent value="transfer" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label>Select items to transfer:</Label>
              <ScrollArea className="h-[150px] rounded-lg border p-2">
                {sourceSession.items?.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between py-2 hover:bg-accent/50 px-2 rounded"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedItems.has(item.id)}
                        onCheckedChange={() => toggleItem(item.id, item.quantity)}
                      />
                      <span>{item.quantity}x {item.name}</span>
                    </div>
                    <span className="font-medium">{formatCurrency(item.total)}</span>
                  </div>
                )) || (
                  <div className="text-center py-4 text-muted-foreground">
                    No items to transfer
                  </div>
                )}
              </ScrollArea>
              {selectedItems.size > 0 && (
                <Badge variant="secondary">
                  {selectedItems.size} items selected
                </Badge>
              )}
            </div>

            <div className="space-y-2">
              <Label>Transfer to:</Label>
              <div className="grid grid-cols-2 gap-2 max-h-[100px] overflow-auto">
                {availableSessions
                  .filter(s => s.id !== sourceSession.id)
                  .map((session) => (
                    <div
                      key={session.id}
                      onClick={() => setTargetSessionId(session.id)}
                      className={`p-2 rounded-lg border cursor-pointer text-sm ${
                        targetSessionId === session.id
                          ? "border-primary bg-primary/10"
                          : "hover:bg-accent"
                      }`}
                    >
                      {session.tableName}
                    </div>
                  ))}
              </div>
            </div>

            <Button
              className="w-full"
              onClick={handleTransfer}
              disabled={!targetSessionId || selectedItems.size === 0 || isLoading}
            >
              <ArrowRightLeft className="h-4 w-4 mr-2" />
              Transfer Items
            </Button>
          </TabsContent>

          <TabsContent value="move" className="space-y-4 mt-4">
            <p className="text-sm text-muted-foreground">
              Move this session to a different table (e.g., customer wants to move outdoors).
            </p>

            <div className="space-y-2">
              <Label>Move to table:</Label>
              <div className="grid grid-cols-3 gap-2 max-h-[150px] overflow-auto">
                {availableTables.map((table) => (
                  <div
                    key={table.id}
                    onClick={() => setTargetTableId(table.id)}
                    className={`p-3 rounded-lg border cursor-pointer text-center ${
                      targetTableId === table.id
                        ? "border-primary bg-primary/10"
                        : "hover:bg-accent"
                    }`}
                  >
                    <div className="font-medium">{table.name}</div>
                    <div className="text-xs text-muted-foreground">#{table.number}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Reason for move..."
                rows={2}
              />
            </div>

            <Button
              className="w-full"
              onClick={handleMove}
              disabled={!targetTableId || isLoading}
            >
              <Move className="h-4 w-4 mr-2" />
              Move to New Table
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

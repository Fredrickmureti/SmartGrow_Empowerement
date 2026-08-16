/**
 * Bill Split Dialog Component
 * 
 * UI for splitting bills by item, seat, or equal parts.
 */

import { useState } from "react";
import { useBillSplitting, SplitType } from "@/hooks/pos/useBillSplitting";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Split, Users, DollarSign, Check, X } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";

interface BillSplitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableSessionId: string;
  totalAmount: number;
  items?: Array<{
    id: string;
    name: string;
    quantity: number;
    total: number;
  }>;
  onPayPortion?: (portionId: string, amount: number) => void;
}

export function BillSplitDialog({
  open,
  onOpenChange,
  tableSessionId,
  totalAmount,
  items = [],
  onPayPortion,
}: BillSplitDialogProps) {
  const { formatCurrency } = useCurrency();
  const {
    splitBill,
    createSplitBill,
    assignItemToPortion,
    markPortionPaid,
    cancelSplitBill,
    calculateEqualSplit,
    getUnpaidPortions,
  } = useBillSplitting(tableSessionId);
  
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [splitCount, setSplitCount] = useState(2);
  const [selectedPortion, setSelectedPortion] = useState<string | null>(null);

  const handleCreateSplit = async () => {
    await createSplitBill.mutateAsync({
      table_session_id: tableSessionId,
      split_type: splitType,
      split_count: splitCount,
    });
  };

  const handlePayPortion = (portionId: string, amount: number) => {
    if (onPayPortion) {
      onPayPortion(portionId, amount);
    } else {
      markPortionPaid.mutate({ portionId });
    }
  };

  // UI PREVIEW ONLY — the authoritative per-portion amounts are computed by
  // `create_pos_split_bill` on the server and read back from `splitBill`.
  const equalAmounts = (() => {
    const base = Math.floor((totalAmount / splitCount) * 100) / 100;
    const remainder = Math.round((totalAmount - base * splitCount) * 100) / 100;
    const amounts = Array(splitCount).fill(base);
    if (remainder > 0) amounts[0] = Math.round((amounts[0] + remainder) * 100) / 100;
    return amounts as number[];
  })();
  const unpaidPortions = getUnpaidPortions();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Split className="h-5 w-5" />
            Split Bill
          </DialogTitle>
        </DialogHeader>

        {!splitBill ? (
          <div className="space-y-6 py-4">
            <Tabs value={splitType} onValueChange={(v) => setSplitType(v as SplitType)}>
              <TabsList className="grid grid-cols-3 w-full">
                <TabsTrigger value="equal">
                  <DollarSign className="h-4 w-4 mr-2" />
                  Equal Split
                </TabsTrigger>
                <TabsTrigger value="by_seat">
                  <Users className="h-4 w-4 mr-2" />
                  By Seat
                </TabsTrigger>
                <TabsTrigger value="by_item">
                  <Split className="h-4 w-4 mr-2" />
                  By Item
                </TabsTrigger>
              </TabsList>

              <TabsContent value="equal" className="space-y-4 mt-4">
                <div className="flex items-center gap-4">
                  <Label>Number of ways to split:</Label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setSplitCount(Math.max(2, splitCount - 1))}
                    >
                      -
                    </Button>
                    <span className="w-12 text-center text-lg font-medium">{splitCount}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setSplitCount(Math.min(10, splitCount + 1))}
                    >
                      +
                    </Button>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  {equalAmounts.map((amount, i) => (
                    <div
                      key={i}
                      className="p-4 rounded-lg border bg-accent/30 flex justify-between items-center"
                    >
                      <span className="text-muted-foreground">Guest {i + 1}</span>
                      <span className="text-lg font-semibold">{formatCurrency(amount)}</span>
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="by_seat" className="space-y-4 mt-4">
                <div className="flex items-center gap-4">
                  <Label>Number of seats:</Label>
                  <Input
                    type="number"
                    min={2}
                    max={10}
                    value={splitCount}
                    onChange={(e) => setSplitCount(parseInt(e.target.value) || 2)}
                    className="w-20"
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  Items will be assigned to each seat after creation.
                </p>
              </TabsContent>

              <TabsContent value="by_item" className="space-y-4 mt-4">
                <p className="text-sm text-muted-foreground">
                  Drag items to different bills after splitting. Each person pays for their own items.
                </p>
                <div className="flex items-center gap-4">
                  <Label>Number of bills:</Label>
                  <Input
                    type="number"
                    min={2}
                    max={10}
                    value={splitCount}
                    onChange={(e) => setSplitCount(parseInt(e.target.value) || 2)}
                    className="w-20"
                  />
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex justify-between items-center pt-4 border-t">
              <div>
                <span className="text-muted-foreground">Total: </span>
                <span className="text-xl font-bold">{formatCurrency(totalAmount)}</span>
              </div>
              <Button onClick={handleCreateSplit} disabled={createSplitBill.isPending}>
                Create Split
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="flex justify-between items-center">
              <Badge variant="outline">
                {splitBill.split_type.replace("_", " ")} split • {splitBill.split_count} ways
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => cancelSplitBill.mutate(splitBill.id)}
              >
                <X className="h-4 w-4 mr-1" />
                Cancel Split
              </Button>
            </div>

            <ScrollArea className="h-[300px]">
              <div className="grid grid-cols-2 gap-3">
                {splitBill.portions?.map((portion) => (
                  <div
                    key={portion.id}
                    className={`p-4 rounded-lg border ${
                      portion.status === "paid"
                        ? "bg-green-500/10 border-green-500/30"
                        : selectedPortion === portion.id
                        ? "border-primary"
                        : "bg-card"
                    }`}
                    onClick={() => portion.status !== "paid" && setSelectedPortion(portion.id)}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className="font-medium">
                        {portion.seat_label || `Bill ${portion.portion_number}`}
                      </span>
                      {portion.status === "paid" ? (
                        <Badge className="bg-green-500">
                          <Check className="h-3 w-3 mr-1" />
                          Paid
                        </Badge>
                      ) : (
                        <Badge variant="outline">Pending</Badge>
                      )}
                    </div>
                    
                    {portion.items && portion.items.length > 0 && (
                      <div className="text-sm text-muted-foreground mb-2">
                        {portion.items.length} items
                      </div>
                    )}
                    
                    <div className="flex justify-between items-center">
                      <span className="text-lg font-bold">
                        {formatCurrency(portion.amount)}
                      </span>
                      {portion.status !== "paid" && (
                        <Button
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePayPortion(portion.id, portion.amount);
                          }}
                        >
                          Pay
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>

            {/* Item assignment for by_item or by_seat modes */}
            {(splitBill.split_type === "by_item" || splitBill.split_type === "by_seat") && selectedPortion && (
              <div className="border-t pt-4">
                <h4 className="text-sm font-medium mb-2">Assign items to selected bill:</h4>
                <div className="space-y-2 max-h-[150px] overflow-auto">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="flex justify-between items-center p-2 rounded border hover:bg-accent cursor-pointer"
                      onClick={() => {
                        assignItemToPortion.mutate({
                          portionId: selectedPortion,
                          transactionItemId: item.id,
                          quantity: item.quantity,
                        });
                      }}
                    >
                      <span>
                        {item.quantity}x {item.name}
                      </span>
                      <span className="font-medium">{formatCurrency(item.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between items-center pt-4 border-t">
              <div>
                <span className="text-muted-foreground">Remaining: </span>
                <span className="text-xl font-bold">
                  {formatCurrency(unpaidPortions.reduce((sum, p) => sum + p.amount, 0))}
                </span>
              </div>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

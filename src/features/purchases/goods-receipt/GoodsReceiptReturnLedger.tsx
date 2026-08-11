/**
 * GoodsReceiptReturnLedger — "what has already gone back" for one receipt.
 *
 * The returned quantity is NOT recomputed here. It comes from the server
 * function `purchase_return_returnable_lines`, the same ledger the create-
 * return screen clamps against, so a receipt and a return can never disagree
 * about how much of a line is still returnable.
 */
import { Badge } from "@/components/ui/badge";
import { useReturnableReceiptLines } from "@/features/purchases/returns/useReturnableReceipts";

export function GoodsReceiptReturnLedger({ receiptId }: { receiptId: string }) {
  const { lines, loading } = useReturnableReceiptLines(receiptId);

  if (loading) {
    return <p className="p-3 text-xs text-muted-foreground">Loading returned quantities…</p>;
  }
  if (lines.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No receipt lines.</p>;
  }

  const anyReturned = lines.some((l) => Number(l.quantity_returned ?? 0) > 0);

  return (
    <div className="space-y-1 p-3 pt-0 text-xs">
      {!anyReturned && (
        <p className="text-muted-foreground">Nothing has been returned from this receipt.</p>
      )}
      <table className="w-full">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal">Item</th>
            <th className="py-1 text-right font-normal">Received</th>
            <th className="py-1 text-right font-normal">Returned</th>
            <th className="py-1 text-right font-normal">Returnable</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.goods_receipt_item_id} className="border-t">
              <td className="py-1 pr-2">
                <span className="align-middle">{l.description}</span>
                {l.lot_number && (
                  <Badge variant="outline" className="ml-1 text-[10px]">
                    Lot {l.lot_number}
                  </Badge>
                )}
                {l.serial_number && (
                  <Badge variant="outline" className="ml-1 text-[10px]">
                    S/N {l.serial_number}
                  </Badge>
                )}
              </td>
              <td className="py-1 text-right tabular-nums">
                {Number(l.quantity_received ?? 0)}
              </td>
              <td className="py-1 text-right tabular-nums">
                {Number(l.quantity_returned ?? 0)}
              </td>
              <td className="py-1 text-right tabular-nums">
                {Number(l.quantity_returnable ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

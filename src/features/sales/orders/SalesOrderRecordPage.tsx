/**
 * SalesOrderRecordPage — the full-page projection of `useSalesOrderView`.
 */
import { useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useRecordPrint } from "@/features/sales/record/useRecordPrint";
import { useCurrency } from "@/hooks/useCurrency";
import { useSalesOrderView } from "./salesOrderView";

export default function SalesOrderRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatCurrency } = useCurrency();
  const { print, printing } = useRecordPrint("sales_order");
  const isNew = id === "new";
  const { order, view } = useSalesOrderView(isNew ? null : id, formatCurrency);

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New sales order"
      onPrint={
        order && !printing
          ? () => void print(order.id, `Sales Order ${order.so_number}`)
          : undefined
      }
    />
  );
}

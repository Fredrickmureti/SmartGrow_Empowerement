/**
 * SalesOrderRecordPage — the full-page projection of `useSalesOrderView`.
 *
 * Actions come from `useSalesOrderActions`, the same array the list row menu
 * renders, so the full page is never a read-only dead end.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useSalesOrderView } from "./salesOrderView";
import { useSalesOrderActions } from "./useSalesOrderActions";

export default function SalesOrderRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { order, refresh, view } = useSalesOrderView(
    isNew ? null : id,
    formatCurrency,
  );

  const { actions, dialogs } = useSalesOrderActions(order, {
    onChanged: refresh,
    onDeleted: () => navigate("/sales/orders"),
  });

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New sales order"
        actions={actions}
      />
      {dialogs}
    </>
  );
}

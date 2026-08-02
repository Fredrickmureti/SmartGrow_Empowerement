/**
 * GoodsReceiptRedirect — GRN convergence (Receiving audit, Phase 4d).
 *
 * The Purchases goods-receipt wizard was a second capture UI: it scanned
 * quantities, lots and serials against a purchase order in parallel with the
 * WMS receiving session, producing two different receiving ledgers for the
 * same physical trailer. Receiving is now captured in exactly one place — a
 * supervised `wms_receiving_sessions` unit of work — and the GRN is the
 * *document* that posting produces, not a place to type numbers.
 *
 * This route keeps every historic deep link
 * (`/purchases/goods-receipt/new?po=<id>`) working by forwarding it to the
 * receiving workspace with the source document pre-bound, so the session opens
 * against the same purchase order the user clicked "Receive goods" on.
 */
import { Navigate, useSearchParams } from "react-router-dom";

export default function GoodsReceiptRedirect() {
  const [params] = useSearchParams();
  const poId = params.get("po") ?? params.get("purchase_order_id");
  const shipmentId = params.get("shipment") ?? params.get("inbound_shipment_id");

  const target = new URLSearchParams();
  if (poId) {
    target.set("source_doc_type", "purchase_order");
    target.set("source_doc_id", poId);
  } else if (shipmentId) {
    target.set("source_doc_type", "inbound_shipment");
    target.set("source_doc_id", shipmentId);
  }

  const query = target.toString();
  return <Navigate to={`/warehouse-app/receiving${query ? `?${query}` : ""}`} replace />;
}

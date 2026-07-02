/**
 * useDocumentNavigation - Cross-document navigation for the Sales module
 * 
 * Provides navigation functions to jump between linked documents:
 * SO ↔ DN ↔ Invoice ↔ Payment ↔ Credit Note
 */
import { useNavigate } from "react-router-dom";
import { useCallback } from "react";

export type SalesDocumentType = 
  | "sales_order" 
  | "delivery_note" 
  | "invoice" 
  | "payment" 
  | "credit_note" 
  | "estimate" 
  | "sales_return";

const ROUTE_MAP: Record<SalesDocumentType, string> = {
  sales_order: "/sales/orders",
  delivery_note: "/sales/delivery-notes",
  invoice: "/sales/invoices",
  payment: "/sales/payments",
  credit_note: "/sales/credit-notes",
  estimate: "/sales/estimates",
  sales_return: "/sales/returns",
};

export function useDocumentNavigation() {
  const navigate = useNavigate();

  /**
   * Navigate to a specific document's page with the document open for editing/viewing
   */
  const navigateToDocument = useCallback(
    (type: SalesDocumentType, documentId: string) => {
      const basePath = ROUTE_MAP[type];
      navigate(`${basePath}?edit=${documentId}`);
    },
    [navigate]
  );

  /**
   * Navigate to a document list page (optionally with a filter)
   */
  const navigateToList = useCallback(
    (type: SalesDocumentType, filter?: Record<string, string>) => {
      const basePath = ROUTE_MAP[type];
      const params = filter ? "?" + new URLSearchParams(filter).toString() : "";
      navigate(`${basePath}${params}`);
    },
    [navigate]
  );

  return {
    navigateToDocument,
    navigateToList,
  };
}

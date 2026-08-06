/**
 * VendorPriceListPeekSheet — drawer projection of `useVendorPriceListView`.
 * All content comes from the shared `DocumentRecordView` descriptor; this
 * file only owns the frame and the vendor preview drawer.
 */
import { useState } from "react";
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import {
  useVendorPriceListView,
  type VendorPriceListEntry,
} from "./vendorPriceListView";

interface VendorPriceListPeekSheetProps {
  entry: VendorPriceListEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (entry: VendorPriceListEntry) => void;
  onDelete: (id: string) => void;
  onSetPreferred: (id: string) => void;
  onCreatePO?: (entry: VendorPriceListEntry) => void;
  onRenew?: (entry: VendorPriceListEntry) => void;
}

export function VendorPriceListPeekSheet({
  entry,
  open,
  onOpenChange,
  onEdit,
  onDelete,
  onSetPreferred,
  onCreatePO,
  onRenew,
}: VendorPriceListPeekSheetProps) {
  const { formatCurrency, baseCurrency } = useCurrency();
  const [vendorOpen, setVendorOpen] = useState(false);

  const { view, actions } = useVendorPriceListView(entry, {
    onOpenChange,
    onEdit,
    onDelete,
    onSetPreferred,
    onCreatePO,
    onRenew,
    onShowVendor: () => setVendorOpen(true),
    formatCurrency,
    baseCurrency,
  });

  return (
    <>
      <PeekScaffold
        {...view}
        open={open}
        onOpenChange={onOpenChange}
        extraHeaderActions={actions.length ? <>{actions}</> : undefined}
      />
      {entry?.vendor_id && (
        <ContactPreviewDrawer
          open={vendorOpen}
          contactId={vendorOpen ? entry.vendor_id : null}
          onOpenChange={(o) => setVendorOpen(o)}
        />
      )}
    </>
  );
}

export default VendorPriceListPeekSheet;

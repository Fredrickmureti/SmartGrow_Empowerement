/**
 * VendorCreditNoteLineageFields — the provenance block shared by the vendor
 * credit note create and edit forms.
 *
 * One component so both forms capture the same lineage with the same rules;
 * the origin decides which upstream reference is demanded (see
 * `lineageError`). Options are scoped to the selected supplier so a credit can
 * never be attached to another vendor's paperwork.
 */
import { FieldGrid } from "@/design-system/primitives/FieldGrid";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePurchaseOrders } from "@/hooks/usePurchaseOrders";
import { usePurchaseReturns } from "@/hooks/usePurchaseReturns";
import { useVendorGoodsReceipts } from "./useVendorGoodsReceipts";
import {
  VENDOR_CREDIT_ORIGINS,
  VENDOR_CREDIT_REASON_CODES,
  originOption,
  type LineageFormState,
} from "./vendorCreditNoteLineage";
import type { VendorCreditOrigin } from "@/hooks/useVendorCreditNotes";

interface Props {
  value: LineageFormState;
  onChange: (patch: Partial<LineageFormState>) => void;
  vendorId: string;
  disabled?: boolean;
}

const NONE = "__none__";

export function VendorCreditNoteLineageFields({
  value,
  onChange,
  vendorId,
  disabled,
}: Props) {
  const { purchaseOrders } = usePurchaseOrders();
  const { purchaseReturns } = usePurchaseReturns();
  const { receipts } = useVendorGoodsReceipts(vendorId || null);

  const option = originOption(value.origin);
  const vendorPOs = purchaseOrders.filter(
    (po) => !vendorId || po.vendor_id === vendorId,
  );
  const vendorReturns = purchaseReturns.filter(
    (r) => !vendorId || r.vendor_id === vendorId,
  );

  return (
    <FieldGrid columns={3}>
      <div className="space-y-2">
        <Label>Origin *</Label>
        <Select
          value={value.origin}
          disabled={disabled}
          onValueChange={(v) => onChange({ origin: v as VendorCreditOrigin })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Why is this credit due?" />
          </SelectTrigger>
          <SelectContent>
            {VENDOR_CREDIT_ORIGINS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {option?.hint && (
          <p className="text-xs text-muted-foreground">{option.hint}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Reason code</Label>
        <Select
          value={value.reason_code || NONE}
          disabled={disabled}
          onValueChange={(v) => onChange({ reason_code: v === NONE ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select reason" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {VENDOR_CREDIT_REASON_CODES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>
          Purchase return
          {option?.requires === "purchase_return" ? " *" : ""}
        </Label>
        <Select
          value={value.source_return_id || NONE}
          disabled={disabled}
          onValueChange={(v) =>
            onChange({ source_return_id: v === NONE ? "" : v })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Select return" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {vendorReturns.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.return_number}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>
          Goods receipt
          {option?.requires === "goods_receipt" ? " *" : ""}
        </Label>
        <Select
          value={value.goods_receipt_id || NONE}
          disabled={disabled}
          onValueChange={(v) =>
            onChange({ goods_receipt_id: v === NONE ? "" : v })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Select receipt" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {receipts.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.receipt_number}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Purchase order</Label>
        <Select
          value={value.purchase_order_id || NONE}
          disabled={disabled}
          onValueChange={(v) =>
            onChange({ purchase_order_id: v === NONE ? "" : v })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Select order" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {vendorPOs.map((po) => (
              <SelectItem key={po.id} value={po.id}>
                {po.po_number}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Supplier credit note #</Label>
        <Input
          value={value.vendor_document_number}
          disabled={disabled}
          placeholder="Their document reference"
          onChange={(e) => onChange({ vendor_document_number: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label>Supplier document date</Label>
        <Input
          type="date"
          value={value.vendor_document_date}
          disabled={disabled}
          onChange={(e) => onChange({ vendor_document_date: e.target.value })}
        />
      </div>
    </FieldGrid>
  );
}

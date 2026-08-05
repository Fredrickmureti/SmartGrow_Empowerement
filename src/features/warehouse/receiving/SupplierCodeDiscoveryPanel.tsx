/**
 * SupplierCodeDiscoveryPanel — Phase 8 remediation surface.
 *
 * When a scan on the dock resolves to `not_found` or `supplier_scoped`, the
 * code is very often the supplier's own part number for something already on
 * the purchase order. Rather than leaving the operator with a dead end, this
 * panel shows the evidence found by `discover_supplier_identity` and lets them
 * link the code to the right item in one confirmed step.
 *
 * The panel never posts stock: linking writes the identifier through the
 * canonical seam, then the operator re-scans and the line captures normally.
 */
import { Link2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  describeEvidence,
  type SupplierDiscovery,
  type SupplierIdentityCandidate,
} from "@/features/products/identity/useSupplierCodeDiscovery";

interface Props {
  discovery: SupplierDiscovery;
  supplierName: string | null;
  busy: boolean;
  error: string | null;
  onLink: (candidate: SupplierIdentityCandidate) => void;
  onDismiss: () => void;
}

export default function SupplierCodeDiscoveryPanel({
  discovery,
  supplierName,
  busy,
  error,
  onLink,
  onDismiss,
}: Props) {
  const linkable = !!discovery.supplierId;

  return (
    <div className="mt-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            <span className="font-mono">{discovery.code}</span> is not a known item code
          </p>
          <p className="text-xs text-muted-foreground">
            {supplierName
              ? `It may be ${supplierName}'s own code. Link it to the item it arrived as — nothing is received until you re-scan.`
              : "Open the inbound document for the right supplier to link this code to an item."}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDismiss} aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {discovery.candidates.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No purchase order line or price list entry suggests what this code is. Enrol it against the
          right item from the product record first.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {discovery.candidates.map((c) => (
            <li
              key={c.productId}
              className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{c.productName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.sku ? `${c.sku} · ` : ""}
                  {describeEvidence(c.evidence)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !linkable}
                onClick={() => onLink(c)}
              >
                <Link2 className="mr-1 h-3.5 w-3.5" /> Link
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

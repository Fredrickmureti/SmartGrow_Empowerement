/**
 * vendorPriceListView — the one description of a Vendor Price List entry.
 *
 * Mirrors the other Purchases view builders: the peek sheet consumes this
 * descriptor so status vocabulary, detail fields and actions live in one
 * place instead of a hand-rolled `DetailSheet` composition.
 */
import { format } from "date-fns";
import { useMemo } from "react";
import type { ReactElement } from "react";
import {
  Edit,
  Star,
  Trash2,
  ShoppingCart,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

import type { DocumentRecordView } from "@/design-system/records";
import { Section, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { DocumentHistoryTab } from "@/components/common/DocumentHistoryTab";
import { ClickableEntity } from "@/components/common/ClickableEntity";

export interface VendorPriceListEntry {
  id: string;
  vendor_id: string;
  product_id: string;
  unit_price: number;
  currency: string | null;
  min_order_qty: number;
  order_increment?: number | null;
  price_break_tiers?: { min_qty: number; unit_price: number }[];
  approval_status?: "draft" | "pending_approval" | "approved" | "rejected";
  lead_time_days: number;
  is_preferred: boolean;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
  notes: string | null;
  created_at?: string;
  vendor?: { name: string } | null;
  product?: { name: string; sku: string | null } | null;
}

function fmt(v?: string | null) {
  if (!v) return "—";
  try {
    return format(new Date(v), "MMM d, yyyy");
  } catch {
    return v;
  }
}

function statusInfo(entry: VendorPriceListEntry) {
  const today = new Date().toISOString().split("T")[0];
  const soon = new Date();
  soon.setDate(soon.getDate() + 30);
  const soonStr = soon.toISOString().split("T")[0];

  if (!entry.is_active)
    return { label: "Inactive", tone: "neutral" as const, icon: XCircle };
  // Governance state outranks the calendar: an unapproved condition prices nothing.
  if (entry.approval_status === "pending_approval")
    return { label: "Awaiting approval", tone: "warning" as const, icon: AlertTriangle };
  if (entry.approval_status === "rejected")
    return { label: "Rejected", tone: "danger" as const, icon: XCircle };
  if (entry.valid_until && entry.valid_until < today)
    return { label: "Expired", tone: "danger" as const, icon: XCircle };
  if (entry.valid_until && entry.valid_until >= today && entry.valid_until <= soonStr)
    return { label: "Expiring soon", tone: "warning" as const, icon: AlertTriangle };
  return { label: "Active", tone: "success" as const, icon: CheckCircle2 };
}


interface Options {
  onOpenChange: (open: boolean) => void;
  onEdit: (entry: VendorPriceListEntry) => void;
  onDelete: (id: string) => void;
  onSetPreferred: (id: string) => void;
  onCreatePO?: (entry: VendorPriceListEntry) => void;
  onRenew?: (entry: VendorPriceListEntry) => void;
  onShowVendor: () => void;
  formatCurrency: (v: number, currency?: string) => string;
  baseCurrency?: string;
}

export interface VendorPriceListViewResult {
  view: DocumentRecordView;
  actions: ReactElement[];
}

export function useVendorPriceListView(
  entry: VendorPriceListEntry | null,
  {
    onOpenChange,
    onEdit,
    onDelete,
    onSetPreferred,
    onCreatePO,
    onRenew,
    onShowVendor,
    formatCurrency,
    baseCurrency,
  }: Options,
): VendorPriceListViewResult {
  return useMemo<VendorPriceListViewResult>(() => {
    if (!entry) {
      return {
        view: {
          kind: "generic",
          eyebrow: "Vendor Price List",
          listPath: "/purchases/price-lists",
          title: "Price list entry",
          notFound: true,
        },
        actions: [],
      };
    }

    const status = statusInfo(entry);
    const isExpired = status.label === "Expired";
    const isActive = entry.is_active && !isExpired;
    const cur = entry.currency || baseCurrency;

    const actions: ReactElement[] = [];
    if (isActive) {
      actions.push(
        <Button
          key="edit"
          size="sm"
          variant="outline"
          onClick={() => {
            onOpenChange(false);
            onEdit(entry);
          }}
        >
          <Edit className="mr-1.5 h-3.5 w-3.5" /> Edit Entry
        </Button>,
      );
    }
    if (isActive && !entry.is_preferred) {
      actions.push(
        <Button
          key="preferred"
          size="sm"
          variant="outline"
          onClick={() => {
            onSetPreferred(entry.id);
            onOpenChange(false);
          }}
        >
          <Star className="mr-1.5 h-3.5 w-3.5" /> Set Preferred
        </Button>,
      );
    }
    if (isActive && onCreatePO) {
      actions.push(
        <Button
          key="po"
          size="sm"
          onClick={() => {
            onOpenChange(false);
            onCreatePO(entry);
          }}
        >
          <ShoppingCart className="mr-1.5 h-3.5 w-3.5" /> Create Purchase Order
        </Button>,
      );
    }
    if (isExpired && onRenew) {
      actions.push(
        <Button
          key="renew"
          size="sm"
          variant="outline"
          onClick={() => {
            onOpenChange(false);
            onRenew(entry);
          }}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Renew Entry
        </Button>,
      );
    }
    if (isExpired) {
      actions.push(
        <Button
          key="reactivate"
          size="sm"
          variant="outline"
          onClick={() => {
            onOpenChange(false);
            onEdit(entry);
          }}
        >
          <Edit className="mr-1.5 h-3.5 w-3.5" /> Edit & Reactivate
        </Button>,
      );
    }
    actions.push(
      <Button
        key="remove"
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => {
          onDelete(entry.id);
          onOpenChange(false);
        }}
      >
        <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
      </Button>,
    );

    const view: DocumentRecordView = {
      kind: "generic",
      eyebrow: "Vendor Price List",
      listPath: "/purchases/price-lists",
      title: entry.product?.name || "Unknown Product",
      docNumber: entry.product?.sku ? `SKU: ${entry.product.sku}` : undefined,
      statusSlot: (
        <span className="flex items-center gap-1.5">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          {entry.is_preferred && (
            <StatusBadge tone="warning">
              <Star className="mr-0.5 h-3 w-3" /> Preferred
            </StatusBadge>
          )}
        </span>
      ),
      meta: (
        <>
          <span>{entry.vendor?.name || "Unknown Vendor"}</span>
          <span className="tabular-nums">{formatCurrency(entry.unit_price, cur)}</span>
        </>
      ),
      detailFields: [
        {
          label: "Vendor",
          value: entry.vendor_id ? (
            <ClickableEntity onClick={onShowVendor}>
              {entry.vendor?.name || "—"}
            </ClickableEntity>
          ) : (
            "—"
          ),
        },
        { label: "Product", value: entry.product?.name || "—" },
        { label: "SKU", value: entry.product?.sku || "—" },
        { label: "Unit price", value: formatCurrency(entry.unit_price, cur) },
        { label: "Min order qty", value: entry.min_order_qty },
        {
          label: "Lead time",
          value: entry.lead_time_days > 0 ? `${entry.lead_time_days} days` : "Not specified",
        },
        { label: "Preferred", value: entry.is_preferred ? "Yes" : "No" },
        { label: "Valid from", value: fmt(entry.valid_from) || "No start date" },
        { label: "Valid until", value: entry.valid_until ? fmt(entry.valid_until) : "No expiry" },
        { label: "Created", value: entry.created_at ? fmt(entry.created_at) : "—" },
      ],
      extraSections: (
        <>
          {entry.notes && (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-sm">{entry.notes}</p>
            </Section>
          )}
          <Section title="Activity">
            <DocumentHistoryTab entityType="vendor_price_list" entityId={entry.id} />
          </Section>
        </>
      ),
    };

    return { view, actions };
  }, [
    entry,
    onOpenChange,
    onEdit,
    onDelete,
    onSetPreferred,
    onCreatePO,
    onRenew,
    onShowVendor,
    formatCurrency,
    baseCurrency,
  ]);
}

/**
 * Test Print hook — receipt settings validation.
 *
 * Renders the operator's *current, unsaved* receipt settings through the
 * ONE front door (`PrintService.renderSnapshotPreview` → `render-document`), then
 * either streams the bytes to the connected thermal printer or downloads
 * them as `.bin` for inspection.
 *
 * Architecture notes:
 *  - There is no second transport. This path uses the same endpoint,
 *    auth, template resolution and ESC/POS builder as a real receipt;
 *    only the document is synthetic.
 *  - `persist: false` — a test print is never archived as a business
 *    artifact and can never be reprinted from the document ledger.
 *  - The fixture sale lives on the client because it is presentation
 *    scaffolding, not business data. The server never reads or writes
 *    `pos_transactions` for a test print.
 *  - The "resolved by server" panel is fed from renderer-reported
 *    metadata (paper, columns, font), so it reflects the bytes actually
 *    produced rather than a client-side re-derivation of policy.
 */
import { useCallback, useState } from "react";
import { downloadPdfBlob } from "@/services/printing/pdfUtils";
import { renderSnapshotPreview } from "@/services/printing/PrintService";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";

import { toast } from "sonner";
import type { ExtendedReceiptSettings } from "@/types/receipt";

export interface TestPrintBranding {
  name?: string | null;
  legal_name?: string | null;
  logo_url?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  tax_id?: string | null;
  base_currency?: string | null;
  timezone?: string | null;
}

export interface ResolvedPrintPolicy {
  /** Resolved paper width (e.g. "80mm"). */
  paper: string | null;
  /** Resolved column count after font + override + margin math. */
  columns: number | null;
  /** Active font (A or B). */
  font: string | null;
  /** Where the resolution came from. */
  source: string | null;
  /** Printer (device assignment) id used, if any. */
  profileId: string | null;
  /** Whether the server overrode the requested paper/render mode. */
  coerced: boolean;
  /** Render medium the server used. */
  renderMode: string | null;
  /** Bytes returned, so the UI can display "X bytes streamed". */
  byteLength: number;
  /** Wall-clock timestamp this resolution was observed. */
  at: number;
}

export interface TestPrintArgs {
  receiptSettings: Partial<ExtendedReceiptSettings>;
  branding?: TestPrintBranding;
  registerName?: string | null;
  cashierName?: string | null;
  /** Optional: `device_assignments.id` whose capabilities to render with. */
  deviceAssignmentId?: string | null;
  /** Optional: stream bytes to a connected printer instead of downloading. */
  printRawBytes?: (
    bytes: Uint8Array,
  ) => Promise<{ success: boolean; error?: string }>;
}

interface PrinterCapabilities {
  columns_override?: number;
  auto_cut?: boolean;
  partial_cut?: boolean;
  qr_native?: boolean;
  code128_native?: boolean;
}

/**
 * Resolve the real printer's capability profile so the test print is
 * geometrically identical to a live receipt on that device.
 */
async function loadCapabilities(
  assignmentId: string | null | undefined,
): Promise<{ capabilities: PrinterCapabilities | null; paperFormat: string | null; font: "A" | "B" | null }> {
  if (!assignmentId) return { capabilities: null, paperFormat: null, font: null };
  const { data } = await supabase
    .from("device_assignments")
    .select("columns_override, font, cutter, qr_native, code128_native, paper_format")
    .eq("id", assignmentId)
    .maybeSingle();
  if (!data) return { capabilities: null, paperFormat: null, font: null };
  const row = data as {
    columns_override: number | null;
    font: "A" | "B" | null;
    cutter: "none" | "partial" | "full" | null;
    qr_native: boolean | null;
    code128_native: boolean | null;
    paper_format: string | null;
  };
  return {
    capabilities: {
      ...(row.columns_override != null ? { columns_override: row.columns_override } : {}),
      auto_cut: row.cutter !== "none",
      partial_cut: row.cutter === "partial",
      qr_native: row.qr_native ?? true,
      code128_native: row.code128_native ?? true,
    },
    paperFormat: row.paper_format,
    font: row.font,
  };
}

/** The synthetic sale a test print exercises. Presentation-only. */
function buildFixtureSnapshot(args: TestPrintArgs): Record<string, unknown> {
  const branding = args.branding ?? {};
  const currency = branding.base_currency || "USD"; // architecture-allow: display-only fallback — test-print fixture, never posted
  const settings = args.receiptSettings ?? {};
  const total = 10.02;
  return {
    document_number: "TEST-PRINT-0001",
    document_type: "pos_receipt",
    document_type_label: "TEST PRINT",
    status: "completed",
    issue_date: new Date().toISOString(),
    subtotal: 10.02,
    tax_amount: 1.48,
    discount_amount: 0.23,
    total,
    amount_paid: total,
    currency,
    notes: null,
    terms: null,
    contact: { name: "Walk-in Customer" },
    organization: {
      id: "preview",
      name: branding.name || "Your Company",
      legal_name: branding.legal_name ?? null,
      logo_url: branding.logo_url ?? null,
      email: branding.email ?? null,
      phone: branding.phone ?? null,
      address: branding.address ?? null,
      city: branding.city ?? null,
      state: branding.state ?? null,
      postal_code: branding.postal_code ?? null,
      country: branding.country ?? null,
      tax_id: branding.tax_id ?? null,
      base_currency: currency,
      timezone: branding.timezone ?? null,
    },
    items: [
      {
        description: "Espresso (double)",
        quantity: 2,
        unit_price: 3.5,
        tax_rate: 16,
        tax_amount: 1.12,
        tax_rate_name: "VAT 16%",
        discount_percent: 0,
        discount_amount: 0,
        line_total: 7.0,
        sku: "BEV-ESP-2",
      },
      {
        description: "Croissant",
        quantity: 1,
        unit_price: 2.25,
        tax_rate: 16,
        tax_amount: 0.36,
        tax_rate_name: "VAT 16%",
        discount_percent: 10,
        discount_amount: 0.23,
        line_total: 2.02,
        sku: "BAK-CRO-1",
      },
      {
        description: "Bottled water 500ml",
        quantity: 1,
        unit_price: 1.0,
        tax_rate: 0,
        tax_amount: 0,
        tax_rate_name: "Zero",
        discount_percent: 0,
        discount_amount: 0,
        line_total: 1.0,
        sku: "BEV-WTR-500",
      },
    ],
    payment_method: "Cash",
    cashier_name: args.cashierName || "Test Cashier",
    register_id: null,
    register_name: args.registerName || "Test Register",
    pos_payments: [{ payment_method: "cash", amount: total, reference: null }],
    etims_cu_number: settings.show_etims_info ? "KRACU0100000001" : null,
    etims_qr_data: settings.show_etims_qr ? "https://etims.kra.go.ke/preview" : null,
    is_voided: false,
    is_refund: false,
    original_transaction_number: null,
    pos_receipt_settings: settings,
  };
}

export function useTestPrintReceipt() {
  const [isPrinting, setIsPrinting] = useState(false);
  const [lastResolved, setLastResolved] = useState<ResolvedPrintPolicy | null>(null);
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { currentBranch } = useBranch();

  const sendTestPrint = useCallback(
    async (args: TestPrintArgs) => {
      setIsPrinting(true);
      try {
        if (!currentOrg?.id || !currentBusiness?.id) {
          throw new Error("Select a company before sending a test print.");
        }
        const { capabilities, paperFormat, font } = await loadCapabilities(
          args.deviceAssignmentId,
        );
        const requestedPaper =
          args.receiptSettings.paper_size === "40mm"
            ? "40mm"
            : args.receiptSettings.paper_size === "58mm"
              ? "58mm"
              : paperFormat ?? "80mm";

        const artifact = await renderSnapshotPreview({
          kindCode: "pos_receipt",
          organizationId: currentOrg.id,
          businessId: currentBusiness.id,
          branchId: currentBranch?.id ?? null,
          medium: "escpos",
          snapshot: buildFixtureSnapshot(args),
          options: {
            paper_format: requestedPaper,
            receiptSettings: args.receiptSettings,
            ...(capabilities ? { capabilities } : {}),
            ...(font ? { font } : {}),
            title: "TEST PRINT",
          },
        });

        const bytes = artifact.bytes;
        const resolved: ResolvedPrintPolicy = {
          paper: artifact.policy?.paper ?? requestedPaper,
          columns: artifact.policy?.columns ?? null,
          font: artifact.policy?.font ?? font,
          source: args.deviceAssignmentId ? "printer" : "settings",
          profileId: args.deviceAssignmentId ?? null,
          coerced: artifact.policy?.coerced ?? false,
          renderMode: artifact.medium,
          byteLength: bytes.byteLength,
          at: Date.now(),
        };
        setLastResolved(resolved);

        if (args.printRawBytes) {
          const result = await args.printRawBytes(bytes);
          if (!result.success) {
            throw new Error(result.error || "Printer reported a failure.");
          }
          toast.success("Test print sent to printer", {
            description: `${bytes.byteLength} bytes streamed at ${resolved.columns ?? "?"} cols (${resolved.paper ?? "?"} Font ${resolved.font ?? "?"}).`,
          });
        } else {
          const ab = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          const blob = new Blob([ab], { type: "application/octet-stream" });
          downloadPdfBlob(blob, "receipt-test-print.bin");
          toast.success("Test receipt downloaded", {
            description: `Resolved ${resolved.columns ?? "?"} cols (${resolved.paper ?? "?"} Font ${resolved.font ?? "?"}).`,
          });
        }
        return resolved;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Test print failed.";
        toast.error("Test print failed", { description: message });
        throw err;
      } finally {
        setIsPrinting(false);
      }
    },
    [currentOrg?.id, currentBusiness?.id, currentBranch?.id],
  );

  return { sendTestPrint, isPrinting, lastResolved };
}

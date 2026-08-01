/**
 * Stage R1.6 + Receipt overhaul Phase 2 — Test Print hook.
 *
 * Renders the user's *current* receipt settings through the same server-side
 * ESC/POS builder a real sale would use, then either streams the bytes to
 * the connected thermal printer (when a hardware proxy is available) or
 * downloads them as `.bin` so the cashier can inspect / replay them.
 *
 * The render goes through `renderDocumentBytesWithPolicy` — the single
 * transport seam in `@/services/printing/pdfUtils` — so the test print uses
 * exactly the same endpoint, auth and error contract as a real receipt. That
 * seam surfaces the `X-Print-Policy-*` response headers (paper, columns,
 * font, profile id, source, coercion), which appear in the editor as a
 * "Resolved by server" diagnostics panel — the only honest signal that the
 * bytes coming back match what the operator configured.
 *
 * The synthetic `pos_receipt_preview` document type is server-guarded —
 * it never reads or writes `pos_transactions`. See
 * `supabase/functions/generate-document/index.ts` ("Stage R1.6" branch).
 */
import { useCallback, useState } from "react";
import {
  downloadPdfBlob,
  renderDocumentBytesWithPolicy,
} from "@/services/printing/pdfUtils";

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
  /** Resolved paper width (e.g. "80mm"). Always present. */
  paper: string | null;
  /** Resolved column count after font + override + margin math. */
  columns: number | null;
  /** Active font (A or B). */
  font: string | null;
  /** Source of the policy ("test-print", "register", "branch", etc.). */
  source: string | null;
  /** Printer profile id used (if any). */
  profileId: string | null;
  /** Whether the policy was coerced (e.g. forced from PDF→ESC/POS). */
  coerced: boolean;
  /** Render mode the server chose. */
  renderMode: string | null;
  /** Bytes returned (so the UI can display "X bytes streamed"). */
  byteLength: number;
  /** Wall-clock timestamp this resolution was observed. */
  at: number;
}

export interface TestPrintArgs {
  receiptSettings: Partial<ExtendedReceiptSettings>;
  branding?: TestPrintBranding;
  registerName?: string | null;
  cashierName?: string | null;
  /** Optional: `device_assignments.id` to resolve at the server. */
  deviceAssignmentId?: string | null;
  /** Optional: stream bytes to a connected printer instead of downloading. */
  printRawBytes?: (
    bytes: Uint8Array,
  ) => Promise<{ success: boolean; error?: string }>;
}

interface TestPrintResponse {
  bytes: Uint8Array;
  resolved: ResolvedPrintPolicy;
}

async function fetchTestPrintBytes(args: TestPrintArgs): Promise<TestPrintResponse> {
  const { bytes, policy } = await renderDocumentBytesWithPolicy({
    documentType: "pos_receipt_preview",
    documentId: "test-print",
    format: "escpos",
    receiptSettings: args.receiptSettings,
    branding: args.branding ?? {},
    registerName: args.registerName ?? null,
    cashierName: args.cashierName ?? null,
    deviceAssignmentId: args.deviceAssignmentId ?? null,
    paperFormat:
      args.receiptSettings.paper_size === "40mm"
        ? "40mm"
        : args.receiptSettings.paper_size === "58mm"
          ? "58mm"
          : "80mm",
  });

  const resolved: ResolvedPrintPolicy = {
    paper: policy?.paper ?? null,
    columns: policy?.columns ?? null,
    font: policy?.font ?? null,
    source: policy?.source ?? null,
    profileId: policy?.profileId ?? null,
    coerced: policy?.coerced ?? false,
    renderMode: policy?.renderMode ?? null,
    byteLength: bytes.byteLength,
    at: Date.now(),
  };
  return { bytes, resolved };
}


export function useTestPrintReceipt() {
  const [isPrinting, setIsPrinting] = useState(false);
  const [lastResolved, setLastResolved] = useState<ResolvedPrintPolicy | null>(null);

  const sendTestPrint = useCallback(async (args: TestPrintArgs) => {
    setIsPrinting(true);
    try {
      const { bytes, resolved } = await fetchTestPrintBytes(args);
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
  }, []);

  return { sendTestPrint, isPrinting, lastResolved };
}

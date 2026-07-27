/**
 * Stage R1.6 + Receipt overhaul Phase 2 — Test Print hook.
 *
 * Renders the user's *current* receipt settings through the same server-side
 * ESC/POS builder a real sale would use, then either streams the bytes to
 * the connected thermal printer (when a hardware proxy is available) or
 * downloads them as `.bin` so the cashier can inspect / replay them.
 *
 * Phase 2: We now use raw `fetch` instead of `supabase.functions.invoke` so
 * we can read the `X-Print-Policy-*` response headers the server emits
 * (paper, columns, font, profile id, source). These are surfaced through
 * `lastResolved` and shown in the editor as a "Resolved by server"
 * diagnostics panel — the only honest signal that the bytes coming back
 * actually match what the operator configured.
 *
 * The synthetic `pos_receipt_preview` document type is server-guarded —
 * it never reads or writes `pos_transactions`. See
 * `supabase/functions/generate-document/index.ts` ("Stage R1.6" branch).
 */
import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { downloadPdfBlob } from "@/services/printing/pdfUtils";
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

const SUPABASE_URL =
  (import.meta as { env?: { VITE_SUPABASE_URL?: string } }).env
    ?.VITE_SUPABASE_URL ??
  "https://jkszmrroyjfdwokbkzis.supabase.co";

async function fetchTestPrintBytes(args: TestPrintArgs): Promise<TestPrintResponse> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  const body = {
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
  };

  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `Server returned ${res.status}`;
    try {
      const text = await res.text();
      if (text) message += `: ${text.slice(0, 200)}`;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const h = res.headers;
  const cols = h.get("X-Print-Policy-Columns");
  const resolved: ResolvedPrintPolicy = {
    paper: h.get("X-Print-Policy-Paper"),
    columns: cols ? Number(cols) : null,
    font: h.get("X-Print-Policy-Font"),
    source: h.get("X-Print-Policy-Source"),
    profileId: h.get("X-Print-Policy-Profile-Id"),
    coerced: h.get("X-Print-Policy-Coerced") === "1",
    renderMode: h.get("X-Print-Policy-Render-Mode"),
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

/**
 * Client KYC export — browser side.
 *
 * Nothing sensitive is decided here: the hook posts the requested scope with
 * the signed-in user's token and saves whatever ZIP the server returns. The
 * backend re-derives the permitted client set, so the scope sent from here can
 * only narrow it.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";

export interface KycExportScope {
  mode: "single" | "bulk";
  clientId?: string;
  businessId?: string;
  branchId?: string | null;
  status?: string | null;
  clientIds?: string[] | null;
}

interface Summary {
  clientCount: number;
  documentsExported: number;
  documentsUnavailable: number;
  status: "success" | "partial";
}

function filenameFrom(header: string | null, fallback: string): string {
  const match = header ? /filename="([^"]+)"/.exec(header) : null;
  return match?.[1] ?? fallback;
}

function readSummary(header: string | null): Summary | null {
  if (!header) return null;
  try {
    return JSON.parse(decodeURIComponent(header)) as Summary;
  } catch {
    return null;
  }
}

export function useKycExport() {
  const [exporting, setExporting] = useState(false);

  const runExport = useCallback(async (scope: KycExportScope) => {
    if (exporting) return false;
    setExporting(true);
    let url: string | null = null;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        toast.error("Your session has expired. Sign in again to export KYC data.");
        return false;
      }

      const response = await fetch("/api/kyc-export", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(scope),
      });

      if (!response.ok) {
        let message = "The KYC export could not be completed.";
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) message = payload.error;
        } catch {
          /* keep the generic message */
        }
        toast.error(message);
        return false;
      }

      const summary = readSummary(response.headers.get("x-kyc-export-summary"));
      const blob = await response.blob();
      url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFrom(
        response.headers.get("content-disposition"),
        "kyc-export.zip",
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      if (summary) {
        const base = `Exported ${summary.clientCount} client(s) — ${summary.documentsExported} file(s)`;
        if (summary.documentsUnavailable > 0) {
          toast.warning(
            `${base}. ${summary.documentsUnavailable} document(s) could not be retrieved; see exceptions.txt in the package.`,
          );
        } else {
          toast.success(base);
        }
      } else {
        toast.success("KYC export downloaded");
      }
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "The KYC export could not be completed.",
      );
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
      setExporting(false);
    }
  }, [exporting]);

  return { runExport, exporting };
}

export default useKycExport;
